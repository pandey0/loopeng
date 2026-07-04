import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { boards, cardQuestions, cards, db, pool, worktrees } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { teardownWorktree } from "@loopeng/worktree-manager";
import { HookRegistry } from "../hooks.js";
import { orchestrateCard } from "../loop.js";

// Standalone, manually-invoked verification of the card-questions-escalation
// spec's full loop with the *real* claude CLI (not a *.test.ts file for the
// same reason verify-pipeline-e2e.ts isn't: the implementer prompt tells the
// agent to run the test suite, which would recurse into `pnpm test` at the
// repo root). Run via `pnpm --filter @loopeng/orchestrator run verify:questions:e2e`.
//
// The answer route itself (POST /cards/:id/questions/:questionId/answer) is
// already covered by a real in-process HTTP call in
// apps/api/src/routes/cards.questions.test.ts -- what that vitest suite
// *can't* cover is whether a real Claude CLI run on the next dispatch
// actually receives the injected Q&A, since that requires a live LLM. This
// script exercises that specific gap: it drives dispatch -> QUESTION ->
// answer (same db update + blocked->ready transition the route performs) ->
// re-dispatch with two real claude CLI invocations, and proves the second
// one saw the answer by having the card deterministically instruct the
// agent to write the exact answer text to a file once it sees a "Previously
// asked" block in its prompt -- that only happens if loadAnsweredQuestions +
// buildImplementerPrompt actually wired the answer into the real prompt sent
// to the CLI, not just that the formatting function produces the right
// string in isolation.
const THE_QUESTION = "should the verify marker file be named qa-verify.txt or qa_verify.txt?";
const THE_ANSWER = "qa-verify.txt";

async function main() {
  const [board] = await db
    .insert(boards)
    .values({ name: "e2e-card-questions-verify (temporary)", description: "card-questions-escalation verification, deleted at end of run" })
    .returning();
  if (!board) throw new Error("failed to insert board");

  const [card] = await db
    .insert(cards)
    .values({
      boardId: board.id,
      title: "e2e: verify card-questions escalation",
      description: [
        "This is a throwaway verification card for the card-questions-escalation feature.",
        "Follow these instructions exactly and do nothing else:",
        "",
        '- If your prompt does NOT already contain a "## Previous questions & answers" section,',
        "  do not read or write any files. Your entire response must be exactly one line:",
        `  QUESTION: ${THE_QUESTION}`,
        "",
        '- If your prompt DOES contain a "## Previous questions & answers" section, read the',
        "  answer given there and create a file at the repo root containing exactly that answer",
        "  text (no trailing newline beyond one), then commit it with git. Do not run any other",
        "  tests or make any other changes.",
      ].join("\n"),
      cardType: "chore",
      state: "ready",
      riskTier: "low",
      touchesArchitecture: false,
      acceptanceCriteria: ["a file containing the given answer text exists at the repo root once answered"],
    })
    .returning();
  if (!card) throw new Error("failed to insert card");

  const hooks = new HookRegistry();
  hooks.on("afterWorktreeCreated", async (ctx) => console.log(`[verify] worktree created for card ${ctx.cardId}`));

  console.log("\n=== dispatch #1: expect the implementer to end its turn with QUESTION: ===");
  const firstOutcome = await orchestrateCard(card.id, hooks);
  console.log("outcome:", firstOutcome);

  const [afterFirstDispatch] = await db.select().from(cards).where(eq(cards.id, card.id));
  const [questionRow] = await db.select().from(cardQuestions).where(eq(cardQuestions.cardId, card.id));

  const dispatch1Ok =
    firstOutcome.status === "blocked" &&
    afterFirstDispatch?.state === "blocked" &&
    questionRow?.status === "open" &&
    questionRow.question.includes(THE_QUESTION);

  console.log("card state after dispatch #1:", afterFirstDispatch?.state);
  console.log("card_questions row:", questionRow);
  console.log(dispatch1Ok ? "[PASS] dispatch #1 paused the card with the question visible" : "[FAIL] dispatch #1 did not pause as expected");

  console.log("\n=== answering (same db update + blocked->ready transition the API route performs) ===");
  if (!questionRow) throw new Error("no card_questions row was created by dispatch #1");
  await db
    .update(cardQuestions)
    .set({ status: "answered", answer: THE_ANSWER, answeredBy: "verify-script@loopeng", answeredAt: new Date() })
    .where(eq(cardQuestions.id, questionRow.id));
  await applyTransition({ cardId: card.id, toState: "ready", actorType: "user" });

  const [afterAnswer] = await db.select().from(cards).where(eq(cards.id, card.id));
  const answerOk = afterAnswer?.state === "ready";
  console.log("card state after answer:", afterAnswer?.state);
  console.log(answerOk ? "[PASS] answering auto-resumed the card to ready" : "[FAIL] answering did not auto-resume the card");

  console.log("\n=== dispatch #2: expect the Q&A to be injected and acted on for real ===");
  const secondOutcome = await orchestrateCard(card.id, hooks);
  console.log("outcome:", secondOutcome);

  const [finalCard] = await db.select().from(cards).where(eq(cards.id, card.id));
  const worktreeId = finalCard?.worktreeId ?? undefined;

  let verifyFileOk = false;
  if (worktreeId) {
    const [worktreeRow] = await db.select().from(worktrees).where(eq(worktrees.id, worktreeId));
    if (worktreeRow) {
      try {
        const content = await readFile(path.join(worktreeRow.fsPath, THE_ANSWER), "utf-8");
        verifyFileOk = content.trim() === THE_ANSWER;
        console.log(`verify file content: ${JSON.stringify(content.trim())}`);
      } catch (err) {
        console.log(`[FAIL] could not read verify file: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    verifyFileOk
      ? "[PASS] dispatch #2's real implementer run saw the injected Q&A and acted on the exact answer"
      : "[FAIL] dispatch #2 did not act on the injected Q&A",
  );

  if (worktreeId) {
    await teardownWorktree(worktreeId, "abandoned").catch((err) => console.warn("[verify] worktree teardown failed:", err));
  }
  await db.delete(boards).where(eq(boards.id, board.id));
  await pool.end();

  const allOk = dispatch1Ok && answerOk && verifyFileOk;
  if (!allOk) {
    console.error("\nCARD QUESTIONS E2E VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\nCARD QUESTIONS E2E VERIFICATION PASSED");
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
