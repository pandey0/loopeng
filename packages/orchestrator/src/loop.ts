import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardQuestions, cards, eventLog, gateDefinitions, gateResults } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { createWorktree, getActiveWorktree } from "@loopeng/worktree-manager";
import { hasDesignerSpecDoc, runDesignerReviewAgent, runDesignerSpecAgent, runImplementerAgent, runReviewerAgent } from "@loopeng/agents";
import { cardTouchesUi, runGatePipeline } from "@loopeng/gates";
import type { HookRegistry } from "./hooks.js";

const MAX_ATTEMPTS = 3;

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
    worktree = await createWorktree(cardId);
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

  let priorFailureNote: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [currentCard] = await db.select().from(cards).where(eq(cards.id, cardId));
    if (!currentCard) throw new Error(`card disappeared mid-run: ${cardId}`);

    const implResult = await runImplementerAgent(currentCard, priorFailureNote);

    // A QUESTION: escalation ends the turn deliberately — it is neither a
    // success nor a failure, so it must not consume one of the MAX_ATTEMPTS
    // retries: the card pauses blocked until a human answers, then resumes
    // to "ready" (event-trigger redispatches it) rather than retrying here.
    if (implResult.question) {
      const truncatedReason = implResult.question.slice(0, QUESTION_REASON_TRUNCATE_LENGTH);
      await db.insert(cardQuestions).values({
        cardId,
        agentRunId: implResult.agentRunId,
        roleName: "implementer",
        question: implResult.question,
        status: "open",
        routedTo: "product_owner",
      });
      await applyTransition({ cardId, toState: "blocked", actorType: "agent" });
      return { status: "blocked", reason: `waiting on answer: ${truncatedReason}` };
    }

    if (implResult.isError) {
      if (attempt < MAX_ATTEMPTS) {
        priorFailureNote = `Implementer run failed: ${implResult.resultText.slice(0, 2000)}`;
        continue; // retry in the same worktree, still in_progress
      }
      await applyTransition({ cardId, toState: "blocked", actorType: "agent" });
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
      if (attempt < MAX_ATTEMPTS) {
        await applyTransition({ cardId, toState: "blocked", actorType: "agent" });
        await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
        priorFailureNote = `Reviewer rejected the previous attempt: ${reviewResult.resultText.slice(0, 2000)}`;
        continue;
      }
      await applyTransition({ cardId, toState: "blocked", actorType: "agent" });
      await hooks.fire("onFailure", { cardId, reason: "review_rejected", attempt });
      return { status: "blocked", reason: "review_rejected" };
    }

    await applyTransition({ cardId, toState: "gate_checks", actorType: "agent" });

    const pipelineResult = await runGatePipeline(currentCard, worktree.fsPath, worktree.baseCommitSha);
    await hooks.fire("afterGateRun", { cardId, gate: "pipeline", passed: pipelineResult.allPassed, results: pipelineResult.results });

    if (!pipelineResult.allPassed) {
      await applyTransition({ cardId, toState: "blocked", actorType: "agent" });
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
