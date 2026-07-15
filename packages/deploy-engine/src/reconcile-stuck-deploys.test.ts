import { eq } from "drizzle-orm";
import { boards, cards, db, deployRecords, gateDefinitions, gateResults, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileStuckDeploys } from "./pipeline.js";

// Regression coverage for the 2026-07-15 incident: reconcileCrashedDeploys
// (pipeline.ts) only runs *reactively*, at the top of a fresh
// runDeployPipeline call for the same card -- which requires a new
// card.moved "-> deploying" event. A card already sitting in "deploying"
// when its deploy attempt's owning process dies never gets one (nothing
// re-enters "deploying" from "deploying" itself), so it's stuck there
// forever with no error and no retry path. reconcileStuckDeploys is the
// boot-time sweep that closes that gap, mirroring reconcileOrphanedRuns for
// restart-orphaned agent runs.
describe("reconcileStuckDeploys", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    await pool.end();
  });

  async function makeCard(title: string, state: string): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({ name: `reconcile-stuck-deploys test project ${title}`, repoPath: "/tmp/reconcile-stuck-deploys-not-a-real-repo" })
      .returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db
      .insert(boards)
      .values({ name: `reconcile-stuck-deploys test board ${title}`, projectId: project.id })
      .returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  it("recovers a card stuck in 'deploying' with no live deploy behind it", async () => {
    const cardId = await makeCard("orphaned mid-deploy", "deploying");
    const [staleRecord] = await db
      .insert(deployRecords)
      .values({ cardId, environment: "production", status: "deploying", startedAt: new Date(Date.now() - 30 * 60 * 1000) })
      .returning({ id: deployRecords.id });
    if (!staleRecord) throw new Error("stale deploy_records insert returned no row");

    const recovered = await reconcileStuckDeploys();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("deploy_failed");

    const [recordAfter] = await db.select().from(deployRecords).where(eq(deployRecords.id, staleRecord.id));
    expect(recordAfter?.status).toBe("crashed");
    expect(recordAfter?.finishedAt).not.toBeNull();
  });

  it("recovers a card stuck in 'deploying' even with no deploy_records row at all -- a real attempt can die before that insert", async () => {
    // Regression: the first version of this sweep only acted when a
    // deploy_records row also said "deploying", on the assumption that no
    // row meant "genuinely mid-flight, not yet inserted." That's wrong at
    // boot -- runDeployPipeline runs entirely in-process, so if this
    // process just booted, nothing from a previous process's attempt can
    // possibly still be running, whether or not it got as far as writing a
    // deploy_records row. Confirmed live: a card died during worktree/repo
    // resolution or lock acquisition, before ever reaching that insert, and
    // sat in "deploying" for 8+ minutes with zero deploy_records rows.
    const cardId = await makeCard("died before any deploy_records row existed", "deploying");

    const recovered = await reconcileStuckDeploys();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("deploy_failed");
  });

  it("ignores cards not in the 'deploying' state", async () => {
    const cardId = await makeCard("already done", "done");
    await db.insert(deployRecords).values({ cardId, environment: "production", status: "live", startedAt: new Date(), finishedAt: new Date() });

    await reconcileStuckDeploys();

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("done");
  });

  it("records a deploy_live gate_results failure for the recovered card", async () => {
    const cardId = await makeCard("orphaned with gate check", "deploying");
    await db.insert(deployRecords).values({ cardId, environment: "production", status: "deploying", startedAt: new Date(Date.now() - 60_000) });

    await reconcileStuckDeploys();

    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
    expect(gateDef).toBeDefined();
    const results = await db.select().from(gateResults).where(eq(gateResults.cardId, cardId));
    const recoveryGate = results.find((g) => JSON.stringify(g.detail).includes("recovered from a crashed deploy attempt"));
    expect(recoveryGate).toBeDefined();
    expect(recoveryGate?.status).toBe("failed");
  });
});
