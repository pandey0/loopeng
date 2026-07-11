import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, cardDependencies, cardQuestions, cards, gateDefinitions, gateResults } from "@loopeng/db";
import type { CardActiveRun, CardDependencyInfo, CardWithStatus } from "@loopeng/shared";

export type { CardActiveRun, CardDependencyInfo, CardWithStatus };

const ACTIVE_STATUSES = ["running", "verifying"] as const;

// Kept short so the one-line blockedReason badge (CardTile) doesn't overflow.
const QUESTION_TRUNCATE_LENGTH = 100;

function truncateQuestion(question: string): string {
  return question.length > QUESTION_TRUNCATE_LENGTH
    ? `${question.slice(0, QUESTION_TRUNCATE_LENGTH).trimEnd()}…`
    : question;
}

// Diagnoses *why* a blocked card is blocked without a human opening card
// detail and reading raw gate_results/agent_runs/card_questions rows — picks
// whichever of (latest failing gate, latest failed/rejected agent run,
// latest open question) happened most recently, since any of the three can
// be the actual cause depending on where the pipeline stopped.
async function computeBlockedReasons(cardIds: string[]): Promise<Map<string, string>> {
  if (cardIds.length === 0) return new Map();

  const [failingGates, candidateRuns, openQuestions] = await Promise.all([
    db
      .select({
        cardId: gateResults.cardId,
        gateKey: gateDefinitions.key,
        detail: gateResults.detail,
        createdAt: gateResults.createdAt,
      })
      .from(gateResults)
      .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
      .where(and(inArray(gateResults.cardId, cardIds), eq(gateResults.status, "failed")))
      .orderBy(desc(gateResults.createdAt)),
    db
      .select({
        cardId: agentRuns.cardId,
        roleName: agentRoles.name,
        verdict: agentRuns.verdict,
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        finishedAt: agentRuns.finishedAt,
      })
      .from(agentRuns)
      .leftJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
      .where(inArray(agentRuns.cardId, cardIds))
      .orderBy(desc(agentRuns.finishedAt)),
    db
      .select({
        cardId: cardQuestions.cardId,
        question: cardQuestions.question,
        createdAt: cardQuestions.createdAt,
      })
      .from(cardQuestions)
      .where(and(inArray(cardQuestions.cardId, cardIds), eq(cardQuestions.status, "open")))
      .orderBy(desc(cardQuestions.createdAt)),
  ]);

  return buildBlockedReasonMap(cardIds, failingGates, candidateRuns, openQuestions);
}

export interface FailingGateRow {
  cardId: string | null;
  gateKey: string | null;
  detail?: unknown;
  createdAt: Date;
}

export interface FailingRunRow {
  cardId: string | null;
  roleName: string | null;
  verdict: string | null;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface OpenQuestionRow {
  cardId: string | null;
  question: string;
  createdAt: Date;
}

// Pure so it's unit-testable without a database: picks, per card, whichever
// of (latest failing gate, latest failed/rejected agent run, latest open
// question) is more recent.
export function buildBlockedReasonMap(
  cardIds: string[],
  gateRows: FailingGateRow[],
  runRows: FailingRunRow[],
  questionRows: OpenQuestionRow[] = [],
): Map<string, string> {
  const result = new Map<string, string>();

  for (const cardId of cardIds) {
    let bestAt: Date | null = null;
    let bestReason: string | null = null;

    for (const row of gateRows) {
      if (row.cardId !== cardId || !row.gateKey) continue;
      if (!bestAt || row.createdAt > bestAt) {
        bestAt = row.createdAt;
        // Prefer the gate's own specific reason (e.g. "target repo missing or
        // not a git repository") over the generic "<key> failed" -- some
        // gates (repo_valid) write a detail.reason precisely so this map
        // doesn't have to fall back to a vague message for them.
        const detailReason =
          row.detail && typeof row.detail === "object" && "reason" in row.detail && typeof (row.detail as { reason: unknown }).reason === "string"
            ? (row.detail as { reason: string }).reason
            : null;
        bestReason = detailReason ?? `${row.gateKey} failed`;
      }
    }

    for (const row of runRows) {
      if (row.cardId !== cardId) continue;
      const isFailure = row.verdict === "fail" || row.status === "failed";
      if (!isFailure) continue;
      const at = row.finishedAt ?? row.startedAt;
      if (!at) continue;
      if (!bestAt || at > bestAt) {
        bestAt = at;
        const role = row.roleName ?? "agent";
        bestReason = row.verdict === "fail" ? `${role} rejected` : `${role} failed`;
      }
    }

    for (const row of questionRows) {
      if (row.cardId !== cardId) continue;
      if (!bestAt || row.createdAt > bestAt) {
        bestAt = row.createdAt;
        bestReason = `waiting on answer: ${truncateQuestion(row.question)}`;
      }
    }

    // A card can end up "blocked" while its most recent run is still parked
    // in running/verifying -- that combination only happens when the API
    // process died mid-run (sessionRegistry and the in-memory orchestrator
    // loop both vanish, but the DB row is never updated) and a human later
    // force-transitioned the card. None of the three sources above match a
    // non-terminal run, so without this the card silently gets no reason at
    // all even though there's an obvious explanation on hand.
    if (!bestReason) {
      let latestRun: FailingRunRow | null = null;
      for (const row of runRows) {
        if (row.cardId !== cardId) continue;
        if (row.status !== "running" && row.status !== "verifying") continue;
        if (!latestRun || (row.startedAt ?? new Date(0)) > (latestRun.startedAt ?? new Date(0))) {
          latestRun = row;
        }
      }
      if (latestRun) {
        const role = latestRun.roleName ?? "agent";
        bestReason = `${role} run interrupted (stuck in "${latestRun.status}" -- likely an API restart mid-run)`;
      }
    }

    // Last-resort fallback: a card is genuinely blocked but none of the
    // known signal sources explain why (e.g. a human blocked it directly, or
    // a failure path that doesn't yet write to any of the three tables
    // above). Surfacing a generic-but-honest message beats a blank/None
    // reason, which reads as "the platform doesn't know either."
    result.set(cardId, bestReason ?? "blocked with no recorded cause -- check agent run and gate history on the card detail page");
  }

  return result;
}

export interface ActiveRunRow {
  id: string;
  cardId: string | null;
  roleName: string | null;
  status: string;
  startedAt: Date | null;
}

/**
 * Answers "does this agent run have a live interactive session right now?".
 * Injected (rather than imported from @loopeng/agents) so board-engine stays
 * free of a dependency on the agent-process layer; the API passes card C's
 * sessionRegistry through.
 */
export type IsRunLive = (agentRunId: string) => boolean;

/**
 * Answers "what's this live run doing right now?" (last tool call or
 * reasoning excerpt). Injected for the same reason as IsRunLive — the API
 * passes card C's session registry through rather than board-engine
 * depending on @loopeng/agents.
 */
export type GetRunSnippet = (agentRunId: string) => string | null;

// Pure: rows must already be sorted by startedAt DESC, so the first
// running/verifying row seen per card is the most recent one.
export function buildActiveAgentRunMap(
  rows: ActiveRunRow[],
  isRunLive?: IsRunLive,
  getSnippet?: GetRunSnippet,
): Map<string, CardActiveRun> {
  const result = new Map<string, CardActiveRun>();
  for (const row of rows) {
    if (!row.cardId || result.has(row.cardId)) continue;
    if (!ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])) continue;
    result.set(row.cardId, {
      agentRunId: row.id,
      roleName: row.roleName,
      status: row.status as CardActiveRun["status"],
      live: isRunLive?.(row.id) ?? false,
      snippet: getSnippet?.(row.id) ?? null,
    });
  }
  return result;
}

async function computeActiveAgentRuns(
  cardIds: string[],
  isRunLive?: IsRunLive,
  getSnippet?: GetRunSnippet,
): Promise<Map<string, CardActiveRun>> {
  if (cardIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: agentRuns.id,
      cardId: agentRuns.cardId,
      roleName: agentRoles.name,
      status: agentRuns.status,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .leftJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
    .where(inArray(agentRuns.cardId, cardIds))
    .orderBy(desc(agentRuns.startedAt));

  return buildActiveAgentRunMap(rows, isRunLive, getSnippet);
}

export interface DependencyEdgeRow {
  cardId: string;
  dependsOnCardId: string;
  dependencyType: string;
}

export interface DependencyTargetRow {
  id: string;
  title: string;
  state: string;
}

// A card's epic (if any) is the *first* "relates_to" edge it has -- the
// only current producer of relates_to edges is persistManagerDecomposition
// (packages/agents/src/decomposition.ts), which always links a fresh child
// card back to its epic exactly once, so "first" is unambiguous in
// practice. blockingCards is every "blocks" dependency whose target isn't
// state=done yet -- the same condition isReady() (dispatch-time) already
// gates on, just surfaced here so the board can show it *before* someone
// drags a card forward into a dependency it can't actually satisfy, instead
// of the card just silently never getting picked up with no explanation.
export function buildDependencyInfoMap(
  cardIds: string[],
  edges: DependencyEdgeRow[],
  referencedCards: DependencyTargetRow[],
): Map<string, CardDependencyInfo> {
  const result = new Map<string, CardDependencyInfo>();
  for (const id of cardIds) result.set(id, { epicId: null, epicTitle: null, blockingCards: [] });

  const referencedById = new Map(referencedCards.map((c) => [c.id, c]));
  for (const edge of edges) {
    const info = result.get(edge.cardId);
    const target = referencedById.get(edge.dependsOnCardId);
    if (!info || !target) continue;
    if (edge.dependencyType === "relates_to" && !info.epicId) {
      info.epicId = target.id;
      info.epicTitle = target.title;
    } else if (edge.dependencyType === "blocks" && target.state !== "done") {
      info.blockingCards.push({ id: target.id, title: target.title });
    }
  }
  return result;
}

async function computeDependencyInfo(cardIds: string[]): Promise<Map<string, CardDependencyInfo>> {
  if (cardIds.length === 0) return buildDependencyInfoMap(cardIds, [], []);

  const edges = await db
    .select({ cardId: cardDependencies.cardId, dependsOnCardId: cardDependencies.dependsOnCardId, dependencyType: cardDependencies.dependencyType })
    .from(cardDependencies)
    .where(inArray(cardDependencies.cardId, cardIds));
  if (edges.length === 0) return buildDependencyInfoMap(cardIds, [], []);

  const referencedIds = [...new Set(edges.map((e) => e.dependsOnCardId))];
  const referenced = await db.select({ id: cards.id, title: cards.title, state: cards.state }).from(cards).where(inArray(cards.id, referencedIds));
  return buildDependencyInfoMap(cardIds, edges, referenced);
}

/**
 * Enriches raw card rows with UI-facing status explainability: why a
 * blocked card is blocked, whether an agent is actively working an
 * in-progress/in-review card, and its epic/unmet-dependency grouping info.
 * All derived from agent_runs/gate_results/card_dependencies rather than
 * stored, so they're always computed fresh off the current data.
 *
 * Generic over the row shape (rather than fixed to the `Card` zod type) so
 * it accepts drizzle's raw `cards` select rows directly — those type
 * `state`/`cardType`/`riskTier` as plain `string`, not the narrower literal
 * unions `Card` declares.
 */
export async function attachCardStatus<T extends { id: string; state: string }>(
  cardRows: T[],
  options?: { isRunLive?: IsRunLive; getSnippet?: GetRunSnippet },
): Promise<(T & Pick<CardWithStatus, "blockedReason" | "activeAgentRun" | "dependencyInfo">)[]> {
  // deploy_failed shares the same "why is this stalled" lookup as blocked --
  // its most common cause is the deploy_live gate failing, already covered
  // by the failingGates query below.
  const blockedCardIds = cardRows
    .filter((c) => c.state === "blocked" || c.state === "deploy_failed")
    .map((c) => c.id);
  const activeCandidateIds = cardRows
    .filter((c) => c.state === "in_progress" || c.state === "in_review")
    .map((c) => c.id);

  const [blockedReasons, activeRuns, dependencyInfo] = await Promise.all([
    computeBlockedReasons(blockedCardIds),
    computeActiveAgentRuns(activeCandidateIds, options?.isRunLive, options?.getSnippet),
    computeDependencyInfo(cardRows.map((c) => c.id)),
  ]);

  return cardRows.map((card) => ({
    ...card,
    blockedReason: blockedReasons.get(card.id) ?? null,
    activeAgentRun: activeRuns.get(card.id) ?? null,
    dependencyInfo: dependencyInfo.get(card.id) ?? { epicId: null, epicTitle: null, blockingCards: [] },
  }));
}
