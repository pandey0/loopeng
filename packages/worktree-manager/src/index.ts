import { execSync } from "node:child_process";
import path from "node:path";
import { simpleGit } from "simple-git";
import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, worktrees } from "@loopeng/db";

function resolveRepoRoot(): string {
  if (process.env.TARGET_REPO_PATH) return process.env.TARGET_REPO_PATH;
  return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
}

function resolveWorktreesRoot(): string {
  return process.env.WORKTREES_PATH ?? path.join(resolveRepoRoot(), "data", "worktrees");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export interface CreateWorktreeOptions {
  baseBranch?: string;
}

// Every card gets exactly one active worktree — this is the structural
// guarantee against parallel-agent file collisions (loop-engineering
// "worktrees" component). Callers should check getActiveWorktree() first.
export async function createWorktree(cardId: string, opts: CreateWorktreeOptions = {}) {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
  if (!card) throw new Error(`card not found: ${cardId}`);

  const repoRoot = resolveRepoRoot();
  const git = simpleGit(repoRoot);
  const baseBranch = opts.baseBranch ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  const baseCommitSha = (await git.revparse(["HEAD"])).trim();

  const branchName = `card/${cardId.slice(0, 8)}-${slugify(card.title)}`;
  const fsPath = path.join(resolveWorktreesRoot(), cardId);

  const [worktreeRow] = await db
    .insert(worktrees)
    .values({
      cardId,
      repoUrl: repoRoot,
      branchName,
      fsPath,
      baseCommitSha,
      status: "creating",
    })
    .returning();
  if (!worktreeRow) throw new Error("failed to insert worktree row");

  try {
    await git.raw(["worktree", "add", fsPath, "-b", branchName, baseBranch]);
  } catch (err) {
    await db.update(worktrees).set({ status: "failed" }).where(eq(worktrees.id, worktreeRow.id));
    throw err;
  }

  const [updated] = await db
    .update(worktrees)
    .set({ status: "active" })
    .where(eq(worktrees.id, worktreeRow.id))
    .returning();

  await db.update(cards).set({ worktreeId: worktreeRow.id }).where(eq(cards.id, cardId));

  return updated!;
}

export async function teardownWorktree(worktreeId: string, mode: "merged" | "abandoned") {
  const [worktree] = await db.select().from(worktrees).where(eq(worktrees.id, worktreeId));
  if (!worktree) throw new Error(`worktree not found: ${worktreeId}`);

  const git = simpleGit(worktree.repoUrl);
  await git.raw(["worktree", "remove", "--force", worktree.fsPath]).catch(() => {
    // dir may already be gone (e.g. manually cleaned up) — fall through to branch cleanup
  });
  if (mode === "abandoned") {
    await git.raw(["branch", "-D", worktree.branchName]).catch(() => {});
  }

  await db.update(cards).set({ worktreeId: null }).where(eq(cards.id, worktree.cardId));

  const [updated] = await db
    .update(worktrees)
    .set({ status: "torn_down", tornDownAt: new Date() })
    .where(eq(worktrees.id, worktreeId))
    .returning();
  return updated!;
}

export async function getActiveWorktree(cardId: string) {
  const [worktree] = await db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.cardId, cardId), eq(worktrees.status, "active")));
  return worktree ?? null;
}

// Bare `git diff` (no args) only shows uncommitted changes — working tree
// vs index. An implementer that follows instructions and commits its work
// leaves a clean tree, so that call is empty on every well-behaved run.
// Diffing against the worktree's own base commit shows everything the
// agent actually did, committed or not.
export function getRepoDiff(fsPath: string, baseRef: string): Promise<string> {
  const git = simpleGit(fsPath);
  return git.diff([`${baseRef}...HEAD`]);
}
