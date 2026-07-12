import { and, desc, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardQuestions, cards, eventLog, gateDefinitions, gateResults } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { createWorktree, getActiveWorktree, InvalidRepoError } from "@loopeng/worktree-manager";
import {
  distillFailureNote,
  hasDesignerSpecDoc,
  isRateLimitError,
  parseRateLimitResetAt,
  resolveQuestionRouting,
  runDesignerReviewAgent,
  runDesignerSpecAgent,
  runImplementerAgent,
  runReviewerAgent,
} from "@loopeng/agents";
import { cardTouchesUi, runGatePipeline } from "@loopeng/gates";
import type { GatePipelineResult } from "@loopeng/gates";
import type { HookRegistry } from "./hooks.js";

const MAX_ATTEMPTS = 3;

// A rate/session-limit hit isn't a real failure of the card's work -- the
// account just can't make another CLI call yet. Retrying immediately (the
// normal MAX_ATTEMPTS loop) would almost certainly hit the same limit
// again, burning a real attempt on nothing; worse, for the reviewer
// specifically, its "fail closed on any CLI error" design (see
// runReviewerAgent) means an unhandled rate-limit read exactly like a
// genuine rejection. Blocks the card (visible, honest reason -- see
// isAutoRetrying) without touching the attempt counter, and schedules a
// real retry later instead of leaving it for a human to notice and requeue.
//
// Only a fallback now -- see resolveRateLimitRetryAt below. Kept because the
// CLI's own message is free-text ("You've hit your session limit · resets
// 1:40am (Asia/Kolkata)"); if its shape ever changes and
// parseRateLimitResetAt can't find a reset clause, retrying blind in 20
// minutes is still better than blocking the card for a human forever.
export const RATE_LIMIT_BACKOFF_MS = Number(process.env.ORCHESTRATOR_RATE_LIMIT_BACKOFF_MS ?? 20 * 60 * 1000);

// Grace period past the account's own stated reset instant -- usage counters
// don't always clear exactly on the second, and retrying right at the edge
// risks reading the same still-active limit and burning the retry for
// nothing.
const RATE_LIMIT_RETRY_BUFFER_MS = 60 * 1000;

// Prefix marker on the card.moved reason recorded by blockForRateLimit --
// stable across the actual minutes-remaining prose, so reconcile.ts can
// pick out rate-limit blocks from every other reason a card ends up
// blocked. Keep it exact and check for it verbatim (mirrors
// RESTART_ORPHAN_MARKER in reconcile.ts).
export const RATE_LIMIT_MARKER = "rate-limited, not a real failure";

// Regression: this used to always schedule a fixed 20-minute retry
// regardless of what the CLI's own message said -- so a card blocked near
// the *start* of a session window ("resets 12:40am", hours away) still
// retried every 20 minutes, hit the same limit each time, and displayed a
// "retrying in ~20 min" reason that had nothing to do with when the account
// would actually be usable again. Parses the real reset instant out of the
// message instead (parseRateLimitResetAt), so the schedule -- and the
// reason text shown on the card -- both reflect reality. Exported so
// reconcile.ts can re-derive the same target instant from a persisted
// reason string.
export function resolveRateLimitRetryAt(resultText: string, referenceTime: Date = new Date()): Date {
  const resetAt = parseRateLimitResetAt(resultText, referenceTime);
  if (resetAt) return new Date(resetAt.getTime() + RATE_LIMIT_RETRY_BUFFER_MS);
  return new Date(referenceTime.getTime() + RATE_LIMIT_BACKOFF_MS);
}

// Exported so reconcile.ts can re-arm a timer for a re-derived retryAt after
// a process restart, instead of only ever scheduling relative to "now" --
// see scheduleRateLimitRetryAt's own setTimeout for why a restart drops this
// silently otherwise.
export function scheduleRateLimitRetryAt(cardId: string, retryAt: Date): void {
  const delayMs = Math.max(retryAt.getTime() - Date.now(), 0);
  setTimeout(() => {
    applyTransition({
      cardId,
      toState: "ready",
      actorType: "automation",
      reason: "auto-retrying after rate-limit backoff",
    }).catch((err) => console.error(`[orchestrator] rate-limit retry requeue failed for card ${cardId}`, err));
  }, delayMs).unref();
}

async function blockForRateLimit(cardId: string, resultText: string): Promise<void> {
  const retryAt = resolveRateLimitRetryAt(resultText);
  const minutes = Math.max(1, Math.round((retryAt.getTime() - Date.now()) / 60000));
  await applyTransition({
    cardId,
    toState: "blocked",
    actorType: "automation",
    reason: `${RATE_LIMIT_MARKER} — retrying automatically in ~${minutes} min: ${resultText.slice(0, 300)}`,
  });
  scheduleRateLimitRetryAt(cardId, retryAt);
}

// Kept short: card_questions.question stores the full text, this is only
// the blockedReason-style summary carried on OrchestrateOutcome.
const QUESTION_REASON_TRUNCATE_LENGTH = 200;

export type OrchestrateOutcome =
  | { status: "awaiting_approval" }
  | { status: "deploying" }
  | { status: "blocked"; reason: string };

async function recordPeerReviewGate(cardId: string, passed: boolean, agentRunId: string, detail: Record<string, unknown>) {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "peer_review"));
  if (!gateDef) {
    console.warn("[orchestrator] peer_review gate_definition not seeded, skipping gate_results row");
    return;
  }
  await db.insert(gateResults).values({
    cardId,
    gateDefinitionId: gateDef.id,
    status: passed ? "passed" : "failed",
    runByAgentRunId: agentRunId,
    detail,
  });
}

async function recordRepoValidGate(cardId: string, passed: boolean, detail: Record<string, unknown>) {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "repo_valid"));
  if (!gateDef) {
    console.warn("[orchestrator] repo_valid gate_definition not seeded, skipping gate_results row");
    return;
  }
  await db.insert(gateResults).values({ cardId, gateDefinitionId: gateDef.id, status: passed ? "passed" : "failed", detail });
}

async function recordDesignReviewGate(cardId: string, passed: boolean, agentRunId: string, detail: Record<string, unknown>) {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "design_review"));
  if (!gateDef) {
    console.warn("[orchestrator] design_review gate_definition not seeded, skipping gate_results row");
    return;
  }
  await db.insert(gateResults).values({
    cardId,
    gateDefinitionId: gateDef.id,
    status: passed ? "passed" : "failed",
    runByAgentRunId: agentRunId,
    detail,
  });
}

// Turns the failed rows out of a live GatePipelineResult into text
// distillFailureNote can work with -- same shape a raw agent transcript
// would be (falls into its tail-lines fallback, since none of this matches
// the CRITERION:/VERDICT: patterns it looks for first).
function formatGateFailureText(results: GatePipelineResult["results"]): string {
  return results
    .filter((r) => r.blocking && r.outcome.status === "failed")
    .map((r) => `GATE FAILED: ${r.name}\n${JSON.stringify(r.outcome.detail).slice(0, 500)}`)
    .join("\n\n");
}

// Same as formatGateFailureText, but reads the persisted gate_results rows
// instead of a live pipeline run -- for reconstructing what a *previous*
// dispatch's gate failure actually said, when this dispatch is starting
// fresh (see loadPriorFailureNote below). A card can accumulate several
// gate_results rows for the same key across attempts; only the most recent
// per key is still relevant.
export async function formatGateFailureTextFromDb(cardId: string): Promise<string> {
  const rows = await db
    .select({ key: gateDefinitions.key, name: gateDefinitions.name, status: gateResults.status, detail: gateResults.detail })
    .from(gateResults)
    .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
    .where(eq(gateResults.cardId, cardId))
    .orderBy(desc(gateResults.createdAt));

  const latestByKey = new Map<string, { name: string; status: string; detail: unknown }>();
  for (const row of rows) {
    if (!latestByKey.has(row.key)) latestByKey.set(row.key, row);
  }

  return [...latestByKey.values()]
    .filter((g) => g.status === "failed")
    .map((g) => `GATE FAILED: ${g.name}\n${JSON.stringify(g.detail).slice(0, 500)}`)
    .join("\n\n");
}

// Prefix markers on the terminal-block reasons that mean "the implementer/
// reviewer/gates genuinely couldn't get this card through, here's why" --
// distinct from every other way a card ends up blocked (rate-limited,
// restart orphan, waiting on a human question) where there's either no
// useful implementer feedback to carry forward, or the card resumes through
// a different path entirely (an answered question doesn't re-run the
// implementer from scratch the same way).
const RETRYABLE_FAILURE_PREFIXES = ["implementer failed after", "review rejected after", "gate(s) failed after"];

// Regression: priorFailureNote used to live only as a loop-local variable,
// reset to undefined at the top of every orchestrateCard call -- so once a
// card exhausted MAX_ATTEMPTS and a human (or an auto-retry path) requeued
// it externally via blocked -> ready, the *new* dispatch started completely
// blind, with no memory of why the previous attempt failed. That defeated
// the entire point of distillFailureNote for exactly the cards that need it
// most: the ones that already failed and are being retried. Reconstructs
// the same note a fresh dispatch would have carried forward if MAX_ATTEMPTS
// hadn't been hit, by reading the last real failure back out of event_log
// (and, for gates specifically, the richer gate_results detail rather than
// the event's own truncated reason text).
export async function loadPriorFailureNote(cardId: string): Promise<string | undefined> {
  // Looks back across the last few card.moved events (not just the very
  // latest, which -- by the time this runs -- is already this run's own
  // "ready" -> "in_progress" transition) for the most recent time this card
  // was blocked, regardless of how many ready/in_progress bounces happened
  // since. That's the most relevant failure context available, whether this
  // dispatch is attempt 1 of a brand-new external Retry or a same-process
  // auto-requeue.
  const recentMoves = await db
    .select({ payload: eventLog.payload })
    .from(eventLog)
    .where(and(eq(eventLog.entityType, "card"), eq(eventLog.entityId, cardId), eq(eventLog.eventType, "card.moved")))
    .orderBy(desc(eventLog.id))
    .limit(5);

  const lastBlock = recentMoves.find((row) => (row.payload as { to?: string }).to === "blocked");
  const reason = (lastBlock?.payload as { reason?: string } | undefined)?.reason;
  if (!reason || !RETRYABLE_FAILURE_PREFIXES.some((prefix) => reason.startsWith(prefix))) return undefined;

  if (reason.startsWith("gate(s) failed after")) {
    const gateText = await formatGateFailureTextFromDb(cardId);
    return gateText ? distillFailureNote("gates_failed", gateText) : undefined;
  }
  const kind = reason.startsWith("implementer failed after") ? "implementer_error" : "review_rejected";
  return distillFailureNote(kind, reason);
}

// The full autonomous loop: cron/event trigger dispatches a ready card here,
// an implementer writes code in an isolated worktree, an independent
// reviewer sub-agent verifies the diff (recorded as the peer_review gate),
// then the Phase 3 gate pipeline runs the remaining checks. All blocking
// gates passing routes by risk_tier — high risk stops for a human approval
// click, low/medium proceed to "deploying". Phase 4 (actual deploy
// execution + deploy_live gate) doesn't exist yet, so a human finishes the
// last mile from there via the board UI.
export async function orchestrateCard(cardId: string, hooks: HookRegistry): Promise<OrchestrateOutcome> {
  await hooks.fire("beforeCardPickup", { cardId });

  const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
  if (!card) throw new Error(`card not found: ${cardId}`);
  if (card.state !== "ready") {
    throw new Error(`card ${cardId} is not in "ready" state (state=${card.state}), refusing to dispatch`);
  }

  let worktree = await getActiveWorktree(cardId);
  if (!worktree) {
    // createWorktree can throw before anything is transitioned off "ready"
    // (e.g. the card's project repo has no .git, or it did at registration
    // time but was since deleted/moved). Left uncaught, that exception
    // propagates out of orchestrateCard into the event-trigger's bare
    // `.catch(console.error)` — the card never leaves "ready", so it looks
    // to a human like nothing is happening rather than like a failure. Catch
    // it here, record a real reason, and land the card in "blocked" instead.
    try {
      worktree = await createWorktree(cardId);
    } catch (err) {
      const reason = err instanceof InvalidRepoError ? err.message : `worktree setup failed: ${(err as Error).message}`;
      await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
      await recordRepoValidGate(cardId, false, { reason });
      await applyTransition({ cardId, toState: "blocked", actorType: "agent", reason });
      await hooks.fire("onFailure", { cardId, reason: "worktree_setup_failed", detail: reason });
      return { status: "blocked", reason };
    }
    await hooks.fire("afterWorktreeCreated", { cardId, worktreeId: worktree.id });
  }

  await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });

  // Designer role (RFC 2026-07 agent org chart): a UI/UX-touching card gets a
  // design spec upstream of the implementer's first run, and a design review
  // downstream alongside peer review. isUiCard is computed once here (not
  // re-checked per attempt) since card.tags/description don't change across
  // retries. hasDesignerSpecDoc guards against re-running the spec agent —
  // and hitting docs.slug's unique constraint — if this card re-enters
  // in_progress later (e.g. after a QUESTION: pause).
  const isUiCard = await cardTouchesUi(card);
  if (isUiCard && !(await hasDesignerSpecDoc(cardId))) {
    await runDesignerSpecAgent(card);
  }

  // Seeded from whatever this card's last real failure was (see
  // loadPriorFailureNote) -- covers a fresh external dispatch (a human
  // clicking Retry, an auto-retry-after-rate-limit) the same way an
  // in-process `continue` below already covers attempt > 1.
  let priorFailureNote: string | undefined = await loadPriorFailureNote(cardId);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [currentCard] = await db.select().from(cards).where(eq(cards.id, cardId));
    if (!currentCard) throw new Error(`card disappeared mid-run: ${cardId}`);

    // The first iteration always sees "in_progress" (just set above), but a
    // retry (attempt > 1) re-reads whatever the card's state actually is
    // right now -- if something outside this loop moved it off in_progress
    // while the killed attempt's process was still winding down (a human
    // stopping the run, another automation blocking the card), respect that
    // instead of blindly spawning another implementer attempt against a
    // card that already moved on. Without this, killing an agent run's
    // process didn't actually stop the card: the loop would just retry.
    if (currentCard.state !== "in_progress") {
      return { status: "blocked", reason: `stopped: card is now "${currentCard.state}", not retrying` };
    }

    const implResult = await runImplementerAgent(currentCard, priorFailureNote);

    // A QUESTION: escalation ends the turn deliberately — it is neither a
    // success nor a failure, so it must not consume one of the MAX_ATTEMPTS
    // retries: the card pauses blocked until a human answers, then resumes
    // to "ready" (event-trigger redispatches it) rather than retrying here.
    if (implResult.question) {
      const truncatedReason = implResult.question.slice(0, QUESTION_REASON_TRUNCATE_LENGTH);
      const routedTo = await resolveQuestionRouting(cardId);
      await db.insert(cardQuestions).values({
        cardId,
        agentRunId: implResult.agentRunId,
        roleName: "implementer",
        question: implResult.question,
        status: "open",
        routedTo,
      });
      // Notification framing depends on who it's routed to (spec:
      // org-chart-manager-agent-role) — a manager-reviewed epic's cards get
      // a manager-drafted framing instead of the raw agent question, since
      // the manager (not the product owner) is the first line of triage.
      await db.insert(eventLog).values({
        entityType: "card",
        entityId: cardId,
        eventType: "card.question_raised",
        actorType: "agent",
        payload: {
          routedTo,
          message: routedTo === "tech-manager" ? `Manager review needed: ${implResult.question}` : implResult.question,
        },
      });
      await applyTransition({ cardId, toState: "blocked", actorType: "agent", reason: `waiting on answer: ${truncatedReason}` });
      return { status: "blocked", reason: `waiting on answer: ${truncatedReason}` };
    }

    if (implResult.isError) {
      if (isRateLimitError(implResult.resultText)) {
        await blockForRateLimit(cardId, implResult.resultText);
        return { status: "blocked", reason: "rate_limited" };
      }
      if (attempt < MAX_ATTEMPTS) {
        priorFailureNote = distillFailureNote("implementer_error", implResult.resultText);
        continue; // retry in the same worktree, still in_progress
      }
      const failReason = `implementer failed after ${MAX_ATTEMPTS} attempts: ${implResult.resultText.slice(0, 300)}`;
      await applyTransition({ cardId, toState: "blocked", actorType: "agent", reason: failReason });
      await hooks.fire("onFailure", { cardId, reason: "implementer_failed", attempt });
      return { status: "blocked", reason: "implementer_failed" };
    }

    await applyTransition({ cardId, toState: "in_review", actorType: "agent" });
    await hooks.fire("beforeSubAgentVerify", { cardId });

    const reviewResult = await runReviewerAgent(currentCard);
    await recordPeerReviewGate(cardId, reviewResult.verdict === "pass", reviewResult.agentRunId, {
      resultText: reviewResult.resultText.slice(0, 4000),
      attempt,
    });

    // Design review runs alongside peer review, same diff. v1 is advisory
    // only — its verdict is recorded as the design_review gate_results row
    // but (unlike peer review) does not itself retry or block the card;
    // out of scope for v1 per the designer-agent-role spec.
    if (isUiCard) {
      const designReviewResult = await runDesignerReviewAgent(currentCard);
      await recordDesignReviewGate(cardId, designReviewResult.verdict === "pass", designReviewResult.agentRunId, {
        resultText: designReviewResult.resultText.slice(0, 4000),
        attempt,
      });
    }

    if (reviewResult.verdict === "fail") {
      // reviewResult.verdict is "fail" for a genuine rejection *and* for a
      // CLI-level error (fail-closed, see runReviewerAgent) -- isError
      // narrows to the latter, and isRateLimitError confirms which kind of
      // error before treating it as exempt from the retry count. A real
      // review rejection still counts normally below.
      if (reviewResult.isError && isRateLimitError(reviewResult.resultText)) {
        await blockForRateLimit(cardId, reviewResult.resultText);
        return { status: "blocked", reason: "rate_limited" };
      }
      if (attempt < MAX_ATTEMPTS) {
        await applyTransition({
          cardId,
          toState: "blocked",
          actorType: "agent",
          reason: `review rejected (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${reviewResult.resultText.slice(0, 300)}`,
        });
        await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
        priorFailureNote = distillFailureNote("review_rejected", reviewResult.resultText);
        continue;
      }
      await applyTransition({
        cardId,
        toState: "blocked",
        actorType: "agent",
        reason: `review rejected after ${MAX_ATTEMPTS} attempts: ${reviewResult.resultText.slice(0, 300)}`,
      });
      await hooks.fire("onFailure", { cardId, reason: "review_rejected", attempt });
      return { status: "blocked", reason: "review_rejected" };
    }

    await applyTransition({ cardId, toState: "gate_checks", actorType: "agent" });

    const pipelineResult = await runGatePipeline(currentCard, worktree.fsPath, worktree.baseCommitSha);
    await hooks.fire("afterGateRun", { cardId, gate: "pipeline", passed: pipelineResult.allPassed, results: pipelineResult.results });

    if (!pipelineResult.allPassed) {
      const failedGates = pipelineResult.results.filter((r) => r.blocking && r.outcome.status === "failed").map((r) => r.name);

      // Regression: this used to always block for a human regardless of
      // attempt count, with no feedback wired anywhere -- neither an
      // in-process retry nor a later external Retry ever told the
      // implementer which gates failed or why (see priorFailureNote's own
      // comment). The reviewer already approved this diff; a failing gate
      // (a broken env var, a flagged secret pattern, a missing ADR link) is
      // exactly the kind of concrete, fixable-on-a-second-pass problem
      // review_rejected already retries for -- there's no principled reason
      // gate failures should be treated differently.
      if (attempt < MAX_ATTEMPTS) {
        await applyTransition({
          cardId,
          toState: "blocked",
          actorType: "agent",
          reason: `gate(s) failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${failedGates.join(", ")}`,
        });
        await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
        priorFailureNote = distillFailureNote("gates_failed", formatGateFailureText(pipelineResult.results));
        continue;
      }
      await applyTransition({
        cardId,
        toState: "blocked",
        actorType: "agent",
        reason: `gate(s) failed after ${MAX_ATTEMPTS} attempts: ${failedGates.join(", ")}`,
      });
      await hooks.fire("onFailure", { cardId, reason: "gates_failed", results: pipelineResult.results });
      return { status: "blocked", reason: "gates_failed" };
    }

    if (currentCard.riskTier === "high") {
      await applyTransition({ cardId, toState: "awaiting_approval", actorType: "agent" });
      await hooks.fire("beforeDeploy", { cardId, requiresHumanApproval: true });
      return { status: "awaiting_approval" };
    }

    await applyTransition({ cardId, toState: "deploying", actorType: "agent" });
    await db.insert(eventLog).values({
      entityType: "card",
      entityId: cardId,
      eventType: "card.awaiting_deploy",
      actorType: "automation",
      payload: { reason: "all gates passed, deploy execution not yet automated (Phase 4)" },
    });
    await hooks.fire("beforeDeploy", { cardId, requiresHumanApproval: false });
    return { status: "deploying" };
  }

  // unreachable — loop always returns within MAX_ATTEMPTS iterations
  throw new Error(`orchestrateCard(${cardId}) exited loop without a result`);
}
