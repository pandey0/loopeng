import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, cards, db, gateResults, pool, projects, worktrees } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { runDeployPipeline } from "./pipeline.js";
import type { DeployProvider } from "./types.js";

// Regression test for the dogfooding incident this card fixes: two deploys
// (e.g. a manual one and an automated one) racing `docker compose up`
// against the same target. Reproduces the race directly against the real DB
// with two real cards that share one project (so they resolve to the same
// repo root -- the actual lock target) and a real advisory-lock-backed
// runDeployPipeline, rather than asserting against the lock module in
// isolation. Without the per-target lock, both calls would reach
// provider.deploy() concurrently; with it, exactly one does and the other
// fails fast into deploy_failed instead of racing docker compose.
describe("runDeployPipeline (concurrent dispatch on the same target)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[], dirs: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  it("lets only one of two concurrent deploys against the same target actually run docker compose, the other fails fast", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "deploy-lock-race-"));
    cleanup.dirs.push(repoRoot);
    const git = simpleGit(repoRoot);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "deploy-lock-race@test.local");
    await git.addConfig("user.name", "deploy-lock-race");
    await git.raw(["commit", "--allow-empty", "-m", "base commit"]);

    const [project] = await db.insert(projects).values({ name: "deploy lock race project", repoPath: repoRoot }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "deploy lock race board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    async function makeDeployingCard(title: string) {
      const [card] = await db.insert(cards).values({ boardId: board!.id, title, state: "deploying" }).returning({ id: cards.id });
      if (!card) throw new Error("card insert returned no row");
      cleanup.cardIds.push(card.id);
      await db.insert(worktrees).values({
        cardId: card.id,
        repoUrl: repoRoot,
        branchName: `card/${card.id.slice(0, 8)}-race`,
        fsPath: path.join(tmpdir(), `unused-fixture-worktree-${card.id}`),
        baseCommitSha: "0".repeat(40),
        status: "active",
      });
      return card.id;
    }

    const [cardA, cardB] = await Promise.all([makeDeployingCard("race: card A"), makeDeployingCard("race: card B")]);

    let activeDeploys = 0;
    let maxConcurrent = 0;
    const deployedCardIds: string[] = [];
    const provider: DeployProvider = {
      key: "fake-lock-race-test",
      async deploy(ctx) {
        activeDeploys++;
        maxConcurrent = Math.max(maxConcurrent, activeDeploys);
        deployedCardIds.push(ctx.card.id);
        await new Promise((r) => setTimeout(r, 250));
        activeDeploys--;
        return { status: "live", createdNewCommit: false, deployedCommitSha: ctx.baseBranch, detail: { fake: true } };
      },
      rollback: () => {
        throw new Error("rollback() should not be called -- the fake provider always reports live");
      },
      async healthCheck() {
        return { healthy: true, detail: {} };
      },
    };

    const results = await Promise.allSettled([runDeployPipeline(cardA, provider), runDeployPipeline(cardB, provider)]);

    // Both calls resolve (the loser fails fast into deploy_failed rather than
    // throwing uncaught), and provider.deploy() only ever ran once -- the
    // lock kept the second call out of docker-compose entirely instead of
    // letting both race it concurrently.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(deployedCardIds).toHaveLength(1);
    expect(maxConcurrent).toBe(1);

    const statuses = (results as PromiseFulfilledResult<{ status: string }>[]).map((r) => r.value.status);
    expect(statuses.filter((s) => s === "done")).toHaveLength(1);
    expect(statuses.filter((s) => s === "deploy_failed")).toHaveLength(1);

    const winnerCardId = deployedCardIds[0]!;
    const loserCardId = winnerCardId === cardA ? cardB : cardA;

    const [winnerAfter] = await db.select().from(cards).where(eq(cards.id, winnerCardId));
    expect(winnerAfter?.state).toBe("done");

    const [loserAfter] = await db.select().from(cards).where(eq(cards.id, loserCardId));
    expect(loserAfter?.state).toBe("deploy_failed");

    const loserGateResults = await db.select().from(gateResults).where(eq(gateResults.cardId, loserCardId));
    const lockFailureGate = loserGateResults.find((g) => JSON.stringify(g.detail).includes("refusing to run concurrently"));
    expect(lockFailureGate).toBeDefined();
    expect(lockFailureGate?.status).toBe("failed");
  }, 30_000);
});
