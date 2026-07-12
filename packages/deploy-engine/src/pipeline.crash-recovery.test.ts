import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, cards, db, deployRecords, gateResults, pool, projects, worktrees } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { runDeployPipeline } from "./pipeline.js";
import type { DeployProvider } from "./types.js";

// Regression test for the other half of this card: a process that crashes
// mid-deploy (disk-full, OOM kill, host reboot) leaves a deploy_records row
// stuck in status "deploying" forever, with no record of what actually
// happened -- previously that required a human to open a DB client and
// UPDATE the row by hand to un-stick the card. Simulates the crash leftover
// directly (insert a "deploying" row, same as runDeployPipeline itself would
// have left mid-flight), then drives a real retry through runDeployPipeline
// and asserts the stale row is reconciled automatically, with no manual DB
// correction, before the fresh attempt proceeds.
describe("runDeployPipeline (crash recovery)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[], dirs: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  it("reconciles a deploy_records row left in 'deploying' status by a crashed prior attempt, instead of leaving it stuck", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "deploy-crash-recovery-"));
    cleanup.dirs.push(repoRoot);
    const git = simpleGit(repoRoot);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "deploy-crash-recovery@test.local");
    await git.addConfig("user.name", "deploy-crash-recovery");
    await git.raw(["commit", "--allow-empty", "-m", "base commit"]);

    const [project] = await db.insert(projects).values({ name: "deploy crash recovery project", repoPath: repoRoot }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "deploy crash recovery board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title: "card resumed after a crashed deploy", state: "deploying" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);

    await db.insert(worktrees).values({
      cardId: card.id,
      repoUrl: repoRoot,
      branchName: `card/${card.id.slice(0, 8)}-crash-recovery`,
      fsPath: path.join(tmpdir(), `unused-fixture-worktree-${card.id}`),
      baseCommitSha: "0".repeat(40),
      status: "active",
    });

    // Simulate the crash leftover: a deploy_records row a previous (now-dead)
    // process started and never finished. Nothing is holding the advisory
    // lock for this target -- exactly the state a real crash would leave.
    const [staleRecord] = await db
      .insert(deployRecords)
      .values({ cardId: card.id, environment: "production", status: "deploying", startedAt: new Date(Date.now() - 60_000) })
      .returning({ id: deployRecords.id });
    if (!staleRecord) throw new Error("stale deploy_records insert returned no row");

    const provider: DeployProvider = {
      key: "fake-crash-recovery-test",
      async deploy(ctx) {
        return { status: "live", createdNewCommit: false, deployedCommitSha: ctx.baseBranch, detail: { fake: true } };
      },
      rollback: () => {
        throw new Error("rollback() should not be called -- the fake provider always reports live");
      },
      async healthCheck() {
        return { healthy: true, detail: {} };
      },
    };

    const result = await runDeployPipeline(card.id, provider);
    expect(result).toEqual({ status: "done" });

    // The stale row is no longer lying about being "in progress" -- it's
    // reconciled to a terminal, inspectable status with a finishedAt, not
    // left stuck forever or silently deleted.
    const [staleAfter] = await db.select().from(deployRecords).where(eq(deployRecords.id, staleRecord.id));
    expect(staleAfter?.status).toBe("crashed");
    expect(staleAfter?.finishedAt).not.toBeNull();

    // The fresh attempt's own row reflects the real outcome.
    const allRecords = await db.select().from(deployRecords).where(eq(deployRecords.cardId, card.id));
    const freshRecord = allRecords.find((r) => r.id !== staleRecord.id);
    expect(freshRecord?.status).toBe("live");

    // The recovery itself is inspectable via gate_results -- no need to
    // infer what happened from the deploy_records status alone.
    const cardGateResults = await db.select().from(gateResults).where(eq(gateResults.cardId, card.id));
    const recoveryGate = cardGateResults.find((g) => JSON.stringify(g.detail).includes("recovered from a crashed deploy attempt"));
    expect(recoveryGate).toBeDefined();
    expect((recoveryGate?.detail as { crashedDeployRecordIds?: string[] })?.crashedDeployRecordIds).toContain(staleRecord.id);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardAfter?.state).toBe("done");
  }, 30_000);
});
