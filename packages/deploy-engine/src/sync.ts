import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { runIntegratorAgent } from "@loopeng/agents";
import { execIn } from "./exec.js";
import type { DeployContext } from "./types.js";

export interface SyncResult {
  ok: boolean;
  detail: Record<string, unknown>;
}

async function rebaseInProgress(worktreePath: string): Promise<boolean> {
  const git = simpleGit(worktreePath);
  const [mergePath, applyPath] = await Promise.all([
    git.raw(["rev-parse", "--git-path", "rebase-merge"]).then((p) => p.trim()),
    git.raw(["rev-parse", "--git-path", "rebase-apply"]).then((p) => p.trim()),
  ]);
  return existsSync(path.resolve(worktreePath, mergePath)) || existsSync(path.resolve(worktreePath, applyPath));
}

// The card's own private branch, not shared history — safe to hard-reset
// back to where the rebase started, unlike anything on the trunk checkout.
async function abortOrReset(git: SimpleGit, worktreePath: string, preRebaseSha: string): Promise<void> {
  if (await rebaseInProgress(worktreePath)) {
    await git.rebase(["--abort"]).catch(() => {});
  } else {
    await git.reset(["--hard", preRebaseSha]).catch(() => {});
  }
}

// Rebases the card's branch onto the latest base branch *inside its own
// isolated worktree*, before deploy() ever touches the shared repoRoot
// checkout. If that hits a conflict, an integrator agent resolves it right
// there in the low-blast-radius worktree — the shared trunk only ever sees
// the result of a rebase that's already clean, never an unresolved conflict.
export async function syncWorktreeOntoBase(ctx: DeployContext): Promise<SyncResult> {
  const git = simpleGit(ctx.worktree.fsPath);
  const preRebaseSha = (await git.revparse(["HEAD"])).trim();

  try {
    await git.rebase([ctx.baseBranch]);
    return { ok: true, detail: { conflicts: false } };
  } catch {
    // fall through to conflict handling below
  }

  const conflictedFiles = (await git.raw(["diff", "--name-only", "--diff-filter=U"]))
    .trim()
    .split("\n")
    .filter(Boolean);

  if (conflictedFiles.length === 0) {
    await abortOrReset(git, ctx.worktree.fsPath, preRebaseSha);
    return { ok: false, detail: { reason: "rebase failed for a reason other than a merge conflict" } };
  }

  const integratorResult = await runIntegratorAgent(ctx.card, ctx.worktree, conflictedFiles);

  if (integratorResult.question) {
    await abortOrReset(git, ctx.worktree.fsPath, preRebaseSha);
    return {
      ok: false,
      detail: { reason: "integrator agent escalated", question: integratorResult.question, agentRunId: integratorResult.agentRunId },
    };
  }
  if (integratorResult.isError) {
    await abortOrReset(git, ctx.worktree.fsPath, preRebaseSha);
    return {
      ok: false,
      detail: {
        reason: "integrator agent errored",
        resultText: integratorResult.resultText.slice(0, 2000),
        agentRunId: integratorResult.agentRunId,
      },
    };
  }
  if (await rebaseInProgress(ctx.worktree.fsPath)) {
    await abortOrReset(git, ctx.worktree.fsPath, preRebaseSha);
    return {
      ok: false,
      detail: { reason: "rebase still unresolved after integrator agent finished", agentRunId: integratorResult.agentRunId },
    };
  }

  // The agent claims the conflict is resolved -- re-run the real test suite
  // before trusting it with a trunk merge. Gates already tested this branch
  // pre-rebase; conflict resolution is new code the gates never saw.
  const test = await execIn(ctx.worktree.fsPath, "pnpm", ["test"], 5 * 60 * 1000);
  if (test.code !== 0) {
    await git.reset(["--hard", preRebaseSha]).catch(() => {});
    return {
      ok: false,
      detail: {
        reason: "tests failed after integrator conflict resolution",
        code: test.code,
        stderrTail: test.stderr.slice(-2000),
        agentRunId: integratorResult.agentRunId,
      },
    };
  }

  return { ok: true, detail: { conflicts: true, resolvedBy: "integrator", agentRunId: integratorResult.agentRunId, conflictedFiles } };
}
