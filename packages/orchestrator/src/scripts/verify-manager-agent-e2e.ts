import { eq } from "drizzle-orm";
import { boards, cardQuestions, cards, db, docs, eventLog, pool } from "@loopeng/db";
import { runManagerAgent, runPlannerAgent } from "@loopeng/agents";
import { applyTransition } from "@loopeng/board-engine";
import { teardownWorktree } from "@loopeng/worktree-manager";
import { HookRegistry } from "../hooks.js";
import { orchestrateCard } from "../loop.js";

// Standalone, manually-invoked verification of the org-chart-manager-agent-role
// spec's full loop with the *real* claude CLI (not a *.test.ts file, for the
// same reason verify-card-questions-e2e.ts isn't: one of the two real runs
// this drives is a real implementer turn, and the implementer prompt tells
// the agent to run the test suite, which would recurse into `pnpm test` at
// the repo root). Run via
// `pnpm --filter @loopeng/orchestrator run verify:manager:e2e`.
//
// Proves both acceptance criteria end to end:
//   1. A real epic card, created via intake (runPlannerAgent), gets a real
//      tech-manager agent run (runManagerAgent) that reviews and can adjust
//      its child cards' breakdown.
//   2. A QUESTION: raised on one of that epic's (possibly manager-adjusted)
//      child cards shows routed_to='tech-manager' and a manager-framed
//      notification (card_questions row + event_log row).
async function main() {
  const [board] = await db
    .insert(boards)
    .values({ name: "e2e-manager-agent-verify (temporary)", description: "org-chart-manager-agent-role verification, deleted at end of run" })
    .returning();
  if (!board) throw new Error("failed to insert board");

  console.log("\n=== step 1: real planner intake run (mints the epic) ===");
  const plannerResult = await runPlannerAgent(
    board.id,
    "We need to add a lightweight 'starred cards' feature: users can star a card from the board " +
      "view and filter the board down to only starred cards. Keep it to a small number of cards.",
  );
  console.log("planner epic card:", plannerResult.epicCardId, "child cards:", plannerResult.cardIds);

  const [epicAfterPlanner] = await db.select().from(cards).where(eq(cards.id, plannerResult.epicCardId));
  const plannerOk = epicAfterPlanner?.cardType === "epic" && plannerResult.cardIds.length > 0;
  console.log(plannerOk ? "[PASS] intake produced a real epic with child cards" : "[FAIL] intake did not produce an epic as expected");

  console.log("\n=== step 2: real tech-manager review run ===");
  const managerResult = await runManagerAgent(plannerResult.epicCardId);
  console.log("manager agent run:", managerResult.agentRunId, "child cards after review:", managerResult.cardIds);

  const managerRunOk = !managerResult.isError && managerResult.cardIds.length > 0;
  console.log(
    managerRunOk
      ? "[PASS] tech-manager agent ran successfully and persisted a (possibly adjusted) breakdown"
      : "[FAIL] tech-manager agent run did not succeed",
  );

  const targetChildCardId = managerResult.cardIds[0];
  if (!targetChildCardId) throw new Error("manager review left no child cards to test escalation routing against");

  console.log("\n=== step 3: raise a QUESTION: on a reviewed epic's child card ===");
  const [child] = await db
    .update(cards)
    .set({
      state: "ready",
      riskTier: "low",
      title: "e2e: verify manager-routed escalation",
      description: [
        "This is a throwaway verification card for the org-chart-manager-agent-role feature.",
        "Do not read or write any files. Your entire response must be exactly one line:",
        "QUESTION: should starred cards persist per-user or per-board?",
      ].join("\n"),
      acceptanceCriteria: ["n/a - verification card, never actually implemented"],
    })
    .where(eq(cards.id, targetChildCardId))
    .returning();
  if (!child) throw new Error("failed to prep target child card");

  const hooks = new HookRegistry();
  const outcome = await orchestrateCard(child.id, hooks);
  console.log("dispatch outcome:", outcome);

  const [questionRow] = await db.select().from(cardQuestions).where(eq(cardQuestions.cardId, child.id));
  const routingOk = outcome.status === "blocked" && questionRow?.routedTo === "tech-manager";
  console.log("card_questions row:", questionRow);
  console.log(routingOk ? "[PASS] question routed_to='tech-manager'" : "[FAIL] question was not routed to tech-manager");

  const cardEvents = await db.select().from(eventLog).where(eq(eventLog.entityId, child.id));
  const questionEvent = cardEvents.find((e) => e.eventType === "card.question_raised");
  const notificationPayload = questionEvent?.payload as { routedTo?: string; message?: string } | undefined;
  const notificationOk = notificationPayload?.routedTo === "tech-manager" && notificationPayload.message?.startsWith("Manager review needed:");
  console.log("card.question_raised event payload:", notificationPayload);
  console.log(notificationOk ? "[PASS] manager-framed notification recorded" : "[FAIL] no manager-framed notification found");

  const [finalChild] = await db.select().from(cards).where(eq(cards.id, child.id));
  const worktreeId = finalChild?.worktreeId ?? undefined;
  if (worktreeId) {
    await teardownWorktree(worktreeId, "abandoned").catch((err) => console.warn("[verify] worktree teardown failed:", err));
  }

  const specDocIds = new Set([plannerResult.specDocId]);
  await db.delete(boards).where(eq(boards.id, board.id));
  for (const docId of specDocIds) {
    await db.delete(docs).where(eq(docs.id, docId));
  }

  await pool.end();

  const allOk = plannerOk && managerRunOk && routingOk && notificationOk;
  if (!allOk) {
    console.error("\nMANAGER AGENT E2E VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\nMANAGER AGENT E2E VERIFICATION PASSED");
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
