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
