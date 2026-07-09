import { and, eq } from "drizzle-orm";
import { agentRoles, agentRuns, boards, cardDocLinks, cards, db, docs, gateDefinitions, gateResults, pool } from "@loopeng/db";
import { teardownWorktree } from "@loopeng/worktree-manager";
import { HookRegistry } from "../hooks.js";
import { orchestrateCard } from "../loop.js";

// Standalone, manually-invoked verification of the designer agent role (spec:
// org-chart-designer-agent-role, RFC 2026-07-agent-org-chart). Deliberately
// NOT a *.test.ts file, for the same reason as verify-pipeline-e2e.ts: it
// drives real cards through orchestrateCard with the real claude CLI and a
// nested `pnpm test`/`pnpm turbo run typecheck` inside the worktrees it
// creates. Run explicitly via `pnpm --filter @loopeng/orchestrator run
// verify:designer:e2e`.
//
// Proves, against real cards:
// 1. a UI-tagged card gets a designer spec doc created and linked before the
//    implementer's first run
// 2. that same card's diff gets a real designer review verdict, and a
//    design_review gate result appears in gate_results
// 3. a non-UI card (no ui/ux tag, no UI paths in its description) never
//    triggers the designer at all
async function main() {
  const [board] = await db
    .insert(boards)
    .values({ name: "e2e-designer-verify (temporary)", description: "Designer agent role verification, deleted at end of run" })
    .returning();
  if (!board) throw new Error("failed to insert board");

  const [uiCard] = await db
    .insert(cards)
    .values({
      boardId: board.id,
      title: "e2e: add a muted Badge variant",
      description:
        "Add a new 'muted' variant to the badgeVariants cva() config in packages/ui/src/components/badge.tsx, " +
        "alongside the existing default/secondary/destructive/success/warning/outline variants. Reuse existing " +
        "design tokens (e.g. bg-muted / text-muted-foreground) — do not introduce hardcoded color values. This " +
        "is a throwaway verification card for the designer-agent-role card.",
      cardType: "feature",
      state: "ready",
      riskTier: "low",
      touchesArchitecture: false,
      tags: ["ui"],
      acceptanceCriteria: [
        "badgeVariants in packages/ui/src/components/badge.tsx has a 'muted' variant built from existing design tokens, not hardcoded colors",
      ],
    })
    .returning();
  if (!uiCard) throw new Error("failed to insert UI card");

  const [nonUiCard] = await db
    .insert(cards)
    .values({
      boardId: board.id,
      title: "e2e: add a DESIGNER_VERIFY_MARKER constant",
      description:
        'Add a new exported string constant named DESIGNER_VERIFY_MARKER to packages/shared/src/index.ts with the value "ok". ' +
        "This is a throwaway non-UI verification card for the designer-agent-role card, confirming the designer never " +
        "engages a card with no ui/ux tag and no UI paths in its description.",
      cardType: "chore",
      state: "ready",
      riskTier: "low",
      touchesArchitecture: false,
      tags: [],
      acceptanceCriteria: ['packages/shared/src/index.ts exports a string constant named DESIGNER_VERIFY_MARKER with the value "ok"'],
    })
    .returning();
  if (!nonUiCard) throw new Error("failed to insert non-UI card");

  const hooks = new HookRegistry();
  hooks.on("afterWorktreeCreated", async (ctx) => console.log(`[verify] worktree created for card ${ctx.cardId}`));
  hooks.on("beforeSubAgentVerify", async (ctx) => console.log(`[verify] implementer done, handing off to reviewer for card ${ctx.cardId}`));
  hooks.on("afterGateRun", async (ctx) => console.log(`[verify] gate pipeline ran for card ${ctx.cardId}, allPassed=${ctx.passed}`));
  hooks.on("onFailure", async (ctx) => console.log(`[verify] orchestration failure: cardId=${ctx.cardId} reason=${ctx.reason} attempt=${ctx.attempt}`));

  const worktreeIds: string[] = [];
  let uiOutcome: Awaited<ReturnType<typeof orchestrateCard>> | undefined;
  let nonUiOutcome: Awaited<ReturnType<typeof orchestrateCard>> | undefined;
  let failure: unknown;

  try {
    console.log(`\n[verify] dispatching UI-tagged card ${uiCard.id}`);
    uiOutcome = await orchestrateCard(uiCard.id, hooks);

    console.log(`\n[verify] dispatching non-UI card ${nonUiCard.id}`);
    nonUiOutcome = await orchestrateCard(nonUiCard.id, hooks);
  } catch (err) {
    failure = err;
  }

  const [finalUiCard] = await db.select().from(cards).where(eq(cards.id, uiCard.id));
  const [finalNonUiCard] = await db.select().from(cards).where(eq(cards.id, nonUiCard.id));
  if (finalUiCard?.worktreeId) worktreeIds.push(finalUiCard.worktreeId);
  if (finalNonUiCard?.worktreeId) worktreeIds.push(finalNonUiCard.worktreeId);

  // 1. designer spec doc created + linked to the UI card, tagged so we can
  // tell it apart from a human/planner-authored spec doc.
  const uiSpecDocs = await db
    .select({ slug: docs.slug, tags: docs.tags, createdAt: docs.createdAt })
    .from(cardDocLinks)
    .innerJoin(docs, eq(cardDocLinks.docId, docs.id))
    .where(and(eq(cardDocLinks.cardId, uiCard.id), eq(cardDocLinks.linkType, "spec")));
  const designSpecDoc = uiSpecDocs.find((d) => d.tags.includes("design-spec"));

  // designer spec run must have started strictly before the implementer's
  // first run — "upstream of the implementer's first run" per the spec.
  const [designerRoleRow] = await db.select().from(agentRoles).where(eq(agentRoles.name, "designer"));
  const [implementerRoleRow] = await db.select().from(agentRoles).where(eq(agentRoles.name, "implementer"));
  const uiCardRuns = await db.select().from(agentRuns).where(eq(agentRuns.cardId, uiCard.id));
  const designerSpecRun = uiCardRuns.find((r) => r.agentRoleId === designerRoleRow?.id && r.status === "succeeded" && r.verdict === null);
  const firstImplementerRun = uiCardRuns
    .filter((r) => r.agentRoleId === implementerRoleRow?.id)
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))[0];
  const specRanBeforeImplementer =
    !!designerSpecRun?.startedAt && !!firstImplementerRun?.startedAt && designerSpecRun.startedAt.getTime() <= firstImplementerRun.startedAt.getTime();

  // 2. a real designer review verdict + design_review gate_results row for
  // the same UI card.
  const designerReviewRun = uiCardRuns.find((r) => r.agentRoleId === designerRoleRow?.id && r.verdict !== null);
  const uiGateRows = await db
    .select({ key: gateDefinitions.key, status: gateResults.status })
    .from(gateResults)
    .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
    .where(eq(gateResults.cardId, uiCard.id));
  const designReviewGateRow = uiGateRows.find((g) => g.key === "design_review");

  // 3. the non-UI card never gets a designer agent_runs row at all.
  const nonUiCardRuns = await db.select().from(agentRuns).where(eq(agentRuns.cardId, nonUiCard.id));
  const designerRanOnNonUiCard = nonUiCardRuns.some((r) => r.agentRoleId === designerRoleRow?.id);
  const nonUiGateRows = await db
    .select({ key: gateDefinitions.key })
    .from(gateResults)
    .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
    .where(eq(gateResults.cardId, nonUiCard.id));
  const designReviewGateOnNonUiCard = nonUiGateRows.some((g) => g.key === "design_review");

  console.log("\n=== designer agent verification result ===");
  console.log("UI card outcome:", uiOutcome ?? "(threw, see error below)");
  console.log("UI card final state:", finalUiCard?.state);
  console.log("design spec doc linked:", !!designSpecDoc, designSpecDoc?.slug);
  console.log("design spec ran before implementer's first run:", specRanBeforeImplementer);
  console.log("designer review run verdict:", designerReviewRun?.verdict);
  console.log("design_review gate result:", designReviewGateRow);
  console.log("non-UI card outcome:", nonUiOutcome ?? "(threw, see error below)");
  console.log("designer ran on non-UI card (should be false):", designerRanOnNonUiCard);
  console.log("design_review gate present on non-UI card (should be false):", designReviewGateOnNonUiCard);
  if (failure) console.error("orchestrateCard threw:", failure);

  for (const worktreeId of worktreeIds) {
    await teardownWorktree(worktreeId, "abandoned").catch((err) => console.warn("[verify] worktree teardown failed:", err));
  }
  // Cascades cards -> cardDocLinks / agentRuns / gateResults / worktrees.
  await db.delete(boards).where(eq(boards.id, board.id));
  if (designSpecDoc) await db.delete(docs).where(eq(docs.slug, designSpecDoc.slug));

  await pool.end();

  const ok =
    !failure &&
    !!designSpecDoc &&
    specRanBeforeImplementer &&
    designerReviewRun?.verdict != null &&
    !!designReviewGateRow &&
    !designerRanOnNonUiCard &&
    !designReviewGateOnNonUiCard;

  if (!ok) {
    console.error("\nDESIGNER AGENT VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("\nDESIGNER AGENT VERIFICATION PASSED");
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
