import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, cards, db, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { createWorktree, InvalidRepoError, isValidGitRepoRoot, resolveRepoRoot, resolveRepoRootForCard } from "./index.js";

describe("isValidGitRepoRoot", () => {
  it("returns false for a directory that doesn't exist", () => {
    expect(isValidGitRepoRoot("/definitely/does/not/exist/anywhere")).toBe(false);
  });

  it("returns false for a directory that exists but isn't a git repo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wt-manager-not-a-repo-"));
    try {
      expect(isValidGitRepoRoot(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns true for a real git repo root", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wt-manager-real-repo-"));
    try {
      await simpleGit(dir).init();
      expect(isValidGitRepoRoot(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoRootForCard", () => {
  const cleanupBoardIds: string[] = [];
  const cleanupProjectIds: string[] = [];
  const cleanupCardIds: string[] = [];
  const cleanupDirs: string[] = [];

  afterAll(async () => {
    for (const id of cleanupCardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanupBoardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanupProjectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  async function makeCard(boardId: string, title: string) {
    const [card] = await db.insert(cards).values({ boardId, title }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanupCardIds.push(card.id);
    return card.id;
  }

  it("resolves to the project's repo_path when the card's board is scoped to a project", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "wt-manager-project-repo-"));
    cleanupDirs.push(repoDir);
    await simpleGit(repoDir).init();

    const [project] = await db.insert(projects).values({ name: "resolveRepoRootForCard test project", repoPath: repoDir }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanupProjectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "resolveRepoRootForCard test board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanupBoardIds.push(board.id);

    const cardId = await makeCard(board.id, "card for scoped project");

    await expect(resolveRepoRootForCard(cardId)).resolves.toBe(repoDir);
  });

  it("falls back to resolveRepoRoot() when the card's board has no project attached", async () => {
    const [board] = await db.insert(boards).values({ name: "resolveRepoRootForCard fallback board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanupBoardIds.push(board.id);

    const cardId = await makeCard(board.id, "card for unscoped board");

    await expect(resolveRepoRootForCard(cardId)).resolves.toBe(resolveRepoRoot());
  });

  it("throws InvalidRepoError with a specific message when the project's repo has no .git", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "wt-manager-invalid-repo-"));
    cleanupDirs.push(notARepo);

    const [project] = await db.insert(projects).values({ name: "resolveRepoRootForCard invalid project", repoPath: notARepo }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanupProjectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "resolveRepoRootForCard invalid board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanupBoardIds.push(board.id);

    const cardId = await makeCard(board.id, "card for invalid project repo");

    await expect(resolveRepoRootForCard(cardId)).rejects.toThrow(InvalidRepoError);
    await expect(resolveRepoRootForCard(cardId)).rejects.toThrow(/target repo missing or not a git repository/);
  });

  it("createWorktree surfaces the same InvalidRepoError instead of a raw simple-git failure, and leaves no worktree row behind", async () => {
    const deletedRepo = await mkdtemp(path.join(tmpdir(), "wt-manager-deleted-repo-"));
    await rm(deletedRepo, { recursive: true, force: true }); // never git-inited, and now doesn't even exist

    const [project] = await db.insert(projects).values({ name: "createWorktree invalid project", repoPath: deletedRepo }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanupProjectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "createWorktree invalid board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanupBoardIds.push(board.id);

    const cardId = await makeCard(board.id, "card that fails worktree creation");

    await expect(createWorktree(cardId)).rejects.toThrow(InvalidRepoError);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.worktreeId).toBeNull();
  });
});
