import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { boards, cards, db, gateDefinitions, gateResults, pool, projects, worktrees } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { runDeployPipeline } from "./pipeline.js";
import type { DeployProvider } from "./types.js";

// Never actually invoked in these tests -- the repo-invalid path returns
// before a provider call happens -- but runDeployPipeline requires one.
const unreachableProvider: DeployProvider = {
  key: "unreachable-test-stub",
  deploy: () => {
    throw new Error("deploy() should not be called when the project repo is invalid");
  },
  rollback: () => {
    throw new Error("rollback() should not be called when the project repo is invalid");
  },
  healthCheck: () => {
    throw new Error("healthCheck() should not be called when the project repo is invalid");
  },
};

describe("runDeployPipeline (invalid project repo)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[], dirs: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  it("lands the card in deploy_failed with a repo_valid gate_results row instead of throwing, when the project's repo has no .git", async () => {
    const goneRepo = await mkdtemp(path.join(tmpdir(), "deploy-pipeline-invalid-repo-"));
    await rm(goneRepo, { recursive: true, force: true }); // registered once, deleted since (the scenario this test covers)
    cleanup.dirs.push(goneRepo);

    const [project] = await db.insert(projects).values({ name: "deploy pipeline invalid project", repoPath: goneRepo }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "deploy pipeline invalid board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "card deployed against a deleted repo", state: "deploying" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);

    await db.insert(worktrees).values({
      cardId: card.id,
      repoUrl: goneRepo,
      branchName: `card/${card.id.slice(0, 8)}-test`,
      fsPath: path.join(tmpdir(), "unused-fixture-worktree-path"),
      baseCommitSha: "0".repeat(40),
      status: "active",
    });

    const result = await runDeployPipeline(card.id, unreachableProvider);
    expect(result).toEqual({ status: "deploy_failed" });

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardAfter?.state).toBe("deploy_failed");

    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "repo_valid"));
    expect(gateDef).toBeDefined();
    const [gateRow] = await db
      .select()
      .from(gateResults)
      .where(eq(gateResults.cardId, card.id));
    expect(gateRow?.status).toBe("failed");
    expect((gateRow?.detail as { reason?: string } | null)?.reason).toMatch(/target repo missing or not a git repository/);
  });
});
