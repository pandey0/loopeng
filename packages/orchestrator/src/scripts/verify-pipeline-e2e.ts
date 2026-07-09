import { eq } from "drizzle-orm";
import { boards, cardDocLinks, cards, db, docs, gateDefinitions, gateResults, pool } from "@loopeng/db";
import { createDoc } from "@loopeng/doc-engine";
import { teardownWorktree } from "@loopeng/worktree-manager";
import { HookRegistry } from "../hooks.js";
import { orchestrateCard } from "../loop.js";

// Standalone, manually-invoked verification that runImplementerAgent /
// runReviewerAgent migrating to runClaudeCliStreamingOnce (card C) didn't
// change orchestrateCard's observable behavior. Deliberately NOT a
// *.test.ts file: it drives a real card through dispatch -> implementer ->
// reviewer -> gate pipeline with the real claude CLI, and the implementer
// prompt itself tells the agent to "run the test suite before finishing"
// (packages/agents/src/prompts.ts) -- i.e. a nested `pnpm test` inside the
// worktree it creates. If this were a vitest test, `pnpm test` at the repo
// root would eventually spawn this same file recursively. Run it explicitly
// via `pnpm --filter @loopeng/orchestrator run verify:e2e`.
async function main() {
  const [board] = await db
    .insert(boards)
    .values({ name: "e2e-pipeline-verify (temporary)", description: "Card C full-pipeline verification, deleted at end of run" })
    .returning();
  if (!board) throw new Error("failed to insert board");

  const doc = await createDoc({
    slug: `e2e-pipeline-verify-${Date.now()}`,
    title: "e2e pipeline verify spec",
    docType: "wiki",
    content:
      "## Summary\n\nThrowaway spec doc for the card-C full-pipeline verification script. " +
      "Confirms dispatch -> implementer -> reviewer -> gate pipeline still works after the " +
      "roles.ts migration to runClaudeCliStreamingOnce.",
    summary: "Throwaway spec doc for the card-C full-pipeline e2e verification script.",
    tags: [],
    message: "e2e pipeline verification doc",
  });

  const [card] = await db
    .insert(cards)
    .values({
      boardId: board.id,
      title: "e2e: add PIPELINE_VERIFY_MARKER constant",
      description:
        "Add a new exported string constant named PIPELINE_VERIFY_MARKER to packages/shared/src/index.ts " +
        'with the value "ok". This is a throwaway verification card for the interactive-agents WebSocket ' +
        "card (card C) -- confirming the implementer/reviewer pipeline still works after migrating to " +
        "streaming CLI transport. Keep the change minimal.",
      cardType: "chore",
      state: "ready",
      riskTier: "low",
      touchesArchitecture: false,
      acceptanceCriteria: ["packages/shared/src/index.ts exports a string constant named PIPELINE_VERIFY_MARKER with the value \"ok\""],
    })
    .returning();
  if (!card) throw new Error("failed to insert card");

  await db.insert(cardDocLinks).values({ cardId: card.id, docId: doc.id, linkType: "spec" });

  const hooks = new HookRegistry();
  hooks.on("afterWorktreeCreated", async (ctx) => console.log(`[verify] worktree created for card ${ctx.cardId}`));
  hooks.on("beforeSubAgentVerify", async (ctx) => console.log(`[verify] implementer done, handing off to reviewer for card ${ctx.cardId}`));
  hooks.on("afterGateRun", async (ctx) => console.log(`[verify] gate pipeline ran, allPassed=${ctx.passed}`));
  hooks.on("beforeDeploy", async (ctx) => console.log(`[verify] reached deploy step, requiresHumanApproval=${ctx.requiresHumanApproval}`));
  hooks.on("onFailure", async (ctx) => console.log(`[verify] orchestration failure: reason=${ctx.reason} attempt=${ctx.attempt}`));

  let worktreeId: string | undefined;
  let outcome: Awaited<ReturnType<typeof orchestrateCard>> | undefined;
  let failure: unknown;

  try {
    outcome = await orchestrateCard(card.id, hooks);
  } catch (err) {
    failure = err;
  }

  const [finalCard] = await db.select().from(cards).where(eq(cards.id, card.id));
  worktreeId = finalCard?.worktreeId ?? undefined;

  const gateRows = await db
    .select({ key: gateDefinitions.key, status: gateResults.status, detail: gateResults.detail })
    .from(gateResults)
    .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
    .where(eq(gateResults.cardId, card.id));

  console.log("\n=== full pipeline verification result ===");
  console.log("outcome:", outcome ?? "(threw, see error below)");
  console.log("final card state:", finalCard?.state);
  console.log("gate results:", gateRows.map((g) => ({ key: g.key, status: g.status })));
  if (failure) console.error("orchestrateCard threw:", failure);

  if (worktreeId) {
    await teardownWorktree(worktreeId, "abandoned").catch((err) => console.warn("[verify] worktree teardown failed:", err));
  }
  // Cascades cards -> cardDocLinks / agentRuns / gateResults / worktrees.
  await db.delete(boards).where(eq(boards.id, board.id));
  await db.delete(docs).where(eq(docs.id, doc.id));

  await pool.end();

  const ok = !failure && outcome?.status === "deploying" && gateRows.every((g) => g.status !== "failed");
  if (!ok) {
    console.error("\nFULL PIPELINE VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\nFULL PIPELINE VERIFICATION PASSED");
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
