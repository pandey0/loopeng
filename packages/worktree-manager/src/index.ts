import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { boards, cards, projects, worktrees } from "@loopeng/db";

export function resolveRepoRoot(): string {
  if (process.env.TARGET_REPO_PATH) return process.env.TARGET_REPO_PATH;
  return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
}

// A repo path is only usable if it's a directory that's the root of a git
// repo -- checking for .git specifically (not `git rev-parse
// --is-inside-work-tree`, which walks up parent directories and would
// happily accept a subdirectory or an unrelated ancestor repo).
export function isValidGitRepoRoot(repoPath: string): boolean {
  return existsSync(repoPath) && existsSync(path.join(repoPath, ".git"));
}

export class InvalidRepoError extends Error {
  constructor(public readonly repoPath: string) {
    super(`target repo missing or not a git repository: ${repoPath}`);
    this.name = "InvalidRepoError";
  }
}

// Resolves the target repo root for a given card: a card's board can be
// scoped to a registered project (boards.project_id), in which case that
// project's repo_path is authoritative. Boards with no project attached
// (the single-project/dogfood case, and any board that predates this
// feature) fall back to the pre-multi-project TARGET_REPO_PATH env var /
// current-repo behavior, unchanged. Always re-validates the resolved path
// actually is a git repo right now -- a project's directory can be deleted
// or moved after registration, and every dispatch must catch that instead
// of letting simple-git throw deep inside createWorktree.
export async function resolveRepoRootForCard(cardId: string): Promise<string> {
  const [row] = await db
    .select({ repoPath: projects.repoPath })
    .from(cards)
    .innerJoin(boards, eq(cards.boardId, boards.id))
    .leftJoin(projects, eq(boards.projectId, projects.id))
    .where(eq(cards.id, cardId));

  const repoPath = row?.repoPath ?? resolveRepoRoot();
  if (!isValidGitRepoRoot(repoPath)) throw new InvalidRepoError(repoPath);
  return repoPath;
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

  const repoRoot = await resolveRepoRootForCard(cardId);
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
    // branchName is deterministic (card id + title, no attempt/timestamp
    // component) -- if `worktree add` got far enough to create the branch
    // before failing on a later step (fsPath collision, fs error, prune
    // racing a crash), every retry hits "branch already exists" and fails
    // identically forever. Best-effort cleanup so a retry gets a clean slate.
    await git.raw(["branch", "-D", branchName]).catch(() => {});
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
