import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, cards, db, gateDefinitions, gateResults, pool, projects, worktrees } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { runDeployPipeline } from "./pipeline.js";
import type { DeployProvider } from "./types.js";

// Regression test for the health dashboard's recent-deploy-status page (see
// apps/api/src/routes/deploys.ts): it renders whatever status the deploy_live
// gate_results row currently has, including "running" -- but nothing wrote a
// "running" row until this card, so an in-progress deploy never actually
// showed up as in-progress. Drives a real deploy through provider.deploy()
// while it's still pending and asserts the gate_results row is visible as
// "running" before it resolves, then transitions to "passed"/"failed"
// afterwards -- the actual data path the dashboard reads.
describe("runDeployPipeline (deploy_live gate 'running' status)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[], dirs: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  async function makeDeployingCard(title: string) {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "deploy-running-status-"));
    cleanup.dirs.push(repoRoot);
    const git = simpleGit(repoRoot);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "deploy-running-status@test.local");
    await git.addConfig("user.name", "deploy-running-status");
    await git.raw(["commit", "--allow-empty", "-m", "base commit"]);

    const [project] = await db.insert(projects).values({ name: `${title} project`, repoPath: repoRoot }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `${title} board`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state: "deploying" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);

    await db.insert(worktrees).values({
      cardId: card.id,
      repoUrl: repoRoot,
      branchName: `card/${card.id.slice(0, 8)}-running-status`,
      fsPath: path.join(tmpdir(), `unused-fixture-worktree-${card.id}`),
      baseCommitSha: "0".repeat(40),
      status: "active",
    });

    return card.id;
  }

  async function deployLiveGateRow(cardId: string) {
    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
    if (!gateDef) throw new Error("deploy_live gate_definition not seeded -- run `pnpm --filter @loopeng/db seed` first");
    const [row] = await db
      .select()
      .from(gateResults)
      .where(eq(gateResults.cardId, cardId))
      .orderBy(gateResults.createdAt);
    return row;
  }

  it("shows the deploy as 'running' while provider.deploy() is still in flight, then 'passed' once it lands", async () => {
    const cardId = await makeDeployingCard("running-status: success");

    let releaseDeploy!: () => void;
    const deployGate = new Promise<void>((resolve) => {
      releaseDeploy = resolve;
    });

    const provider: DeployProvider = {
      key: "fake-running-status-success",
      async deploy(ctx) {
        // At this point runDeployPipeline must already have written the
        // "running" row -- assert it before letting deploy() resolve.
        const row = await deployLiveGateRow(cardId);
        expect(row?.status).toBe("running");
        await deployGate;
        return { status: "live", createdNewCommit: false, deployedCommitSha: ctx.baseBranch, detail: { fake: true } };
      },
      rollback: () => {
        throw new Error("rollback() should not be called -- the fake provider always reports live");
      },
      async healthCheck() {
        return { healthy: true, detail: {} };
      },
    };

    // deployGate is only there to force deploy() to actually await something
    // between the in-flight assertion and returning -- resolving it up front
    // doesn't change ordering, since the assertion still runs synchronously
    // before deploy() reaches the `await deployGate` line.
    releaseDeploy();
    const result = await runDeployPipeline(cardId, provider);

    expect(result).toEqual({ status: "done" });
    const row = await deployLiveGateRow(cardId);
    expect(row?.status).toBe("passed");
  }, 30_000);

  it("shows the deploy as 'running' while provider.deploy() is still in flight, then 'failed' once it errors out", async () => {
    const cardId = await makeDeployingCard("running-status: failure");

    let releaseDeploy!: () => void;
    const deployGate = new Promise<void>((resolve) => {
      releaseDeploy = resolve;
    });

    const provider: DeployProvider = {
      key: "fake-running-status-failure",
      async deploy() {
        const row = await deployLiveGateRow(cardId);
        expect(row?.status).toBe("running");
        await deployGate;
        return { status: "failed", createdNewCommit: false, detail: { reason: "health check timed out" } };
      },
      rollback: () => {
        throw new Error("rollback() should not be called -- createdNewCommit is false");
      },
      async healthCheck() {
        return { healthy: false, detail: {} };
      },
    };

    releaseDeploy();
    const result = await runDeployPipeline(cardId, provider);

    expect(result).toEqual({ status: "deploy_failed" });
    const row = await deployLiveGateRow(cardId);
    expect(row?.status).toBe("failed");
    expect((row?.detail as { deployFailure?: { reason?: string } } | null)?.deployFailure?.reason).toBe("health check timed out");
  }, 30_000);
});
