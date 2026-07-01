import type { cards, worktrees } from "@loopeng/db";

export type CardRow = typeof cards.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;

export interface DeployContext {
  card: CardRow;
  worktree: WorktreeRow;
  repoRoot: string;
  baseBranch: string;
}

export interface DeployResult {
  status: "live" | "failed";
  deployedCommitSha?: string;
  deployUrl?: string;
  monitoringDashboardUrl?: string;
  // True only if this call created a brand new commit on the base branch
  // (a real merge). If the card's branch was already an ancestor of HEAD
  // (e.g. re-merged after an earlier revert), this is false — rollback must
  // never git-revert HEAD in that case, since HEAD wouldn't be a commit we
  // own and reverting it would touch unrelated history.
  createdNewCommit: boolean;
  detail: Record<string, unknown>;
}

export interface HealthStatus {
  healthy: boolean;
  detail: Record<string, unknown>;
}

export interface DeployProvider {
  key: string;
  deploy(ctx: DeployContext): Promise<DeployResult>;
  rollback(ctx: DeployContext, toCommitSha: string): Promise<DeployResult>;
  healthCheck(ctx: DeployContext): Promise<HealthStatus>;
}
