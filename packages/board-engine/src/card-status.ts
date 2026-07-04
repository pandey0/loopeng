import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, gateDefinitions, gateResults } from "@loopeng/db";
import type { CardActiveRun, CardWithStatus } from "@loopeng/shared";

export type { CardActiveRun, CardWithStatus };

const ACTIVE_STATUSES = ["running", "verifying"] as const;

// Diagnoses *why* a blocked card is blocked without a human opening card
// detail and reading raw gate_results/agent_runs rows — picks whichever of
// (latest failing gate, latest failed/rejected agent run) happened most
// recently, since either can be the actual cause depending on where the
// pipeline stopped.
async function computeBlockedReasons(cardIds: string[]): Promise<Map<string, string>> {
  if (cardIds.length === 0) return new Map();

  const [failingGates, candidateRuns] = await Promise.all([
    db
      .select({
        cardId: gateResults.cardId,
        gateKey: gateDefinitions.key,
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
  ]);

  return buildBlockedReasonMap(cardIds, failingGates, candidateRuns);
}

export interface FailingGateRow {
  cardId: string | null;
  gateKey: string | null;
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

// Pure so it's unit-testable without a database: picks, per card, whichever
// of (latest failing gate, latest failed/rejected agent run) is more recent.
export function buildBlockedReasonMap(
  cardIds: string[],
  gateRows: FailingGateRow[],
  runRows: FailingRunRow[],
): Map<string, string> {
  const result = new Map<string, string>();

  for (const cardId of cardIds) {
    let bestAt: Date | null = null;
    let bestReason: string | null = null;

    for (const row of gateRows) {
      if (row.cardId !== cardId || !row.gateKey) continue;
      if (!bestAt || row.createdAt > bestAt) {
        bestAt = row.createdAt;
        bestReason = `${row.gateKey} failed`;
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

    if (bestReason) result.set(cardId, bestReason);
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

// Pure: rows must already be sorted by startedAt DESC, so the first
// running/verifying row seen per card is the most recent one.
export function buildActiveAgentRunMap(rows: ActiveRunRow[], isRunLive?: IsRunLive): Map<string, CardActiveRun> {
  const result = new Map<string, CardActiveRun>();
  for (const row of rows) {
    if (!row.cardId || result.has(row.cardId)) continue;
    if (!ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number])) continue;
    result.set(row.cardId, {
      agentRunId: row.id,
      roleName: row.roleName,
      status: row.status as CardActiveRun["status"],
      live: isRunLive?.(row.id) ?? false,
    });
  }
  return result;
}

async function computeActiveAgentRuns(cardIds: string[], isRunLive?: IsRunLive): Promise<Map<string, CardActiveRun>> {
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

  return buildActiveAgentRunMap(rows, isRunLive);
}

/**
 * Enriches raw card rows with UI-facing status explainability: why a
 * blocked card is blocked, and whether an agent is actively working an
 * in-progress/in-review card. Both are derived from agent_runs/gate_results
 * rather than stored, so they're always computed fresh off the current data.
 *
 * Generic over the row shape (rather than fixed to the `Card` zod type) so
 * it accepts drizzle's raw `cards` select rows directly — those type
 * `state`/`cardType`/`riskTier` as plain `string`, not the narrower literal
 * unions `Card` declares.
 */
export async function attachCardStatus<T extends { id: string; state: string }>(
  cardRows: T[],
  options?: { isRunLive?: IsRunLive },
): Promise<(T & Pick<CardWithStatus, "blockedReason" | "activeAgentRun">)[]> {
  const blockedCardIds = cardRows.filter((c) => c.state === "blocked").map((c) => c.id);
  const activeCandidateIds = cardRows
    .filter((c) => c.state === "in_progress" || c.state === "in_review")
    .map((c) => c.id);

  const [blockedReasons, activeRuns] = await Promise.all([
    computeBlockedReasons(blockedCardIds),
    computeActiveAgentRuns(activeCandidateIds, options?.isRunLive),
  ]);

  return cardRows.map((card) => ({
    ...card,
    blockedReason: blockedReasons.get(card.id) ?? null,
    activeAgentRun: activeRuns.get(card.id) ?? null,
  }));
}
