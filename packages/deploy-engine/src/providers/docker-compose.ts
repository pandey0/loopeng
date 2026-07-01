import { simpleGit } from "simple-git";
import { execIn } from "../exec.js";
import type { DeployContext, DeployProvider, DeployResult, HealthStatus } from "../types.js";

const API_URL = process.env.DEPLOY_HEALTH_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const COMPOSE_FILE = "infrastructure/docker/docker-compose.yml";

async function pollHealth(ctx: DeployContext, timeoutMs: number): Promise<HealthStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && body.status === "ok") return { healthy: true, detail: body };
      lastDetail = { httpStatus: res.status, body };
    } catch (err) {
      lastDetail = { error: (err as Error).message };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { healthy: false, detail: lastDetail };
}

// The only realistically testable provider in a sandbox with no SSH target
// host: merges the card's branch into base locally, builds+runs the real
// docker-compose stack, and health-checks the API's own /health endpoint.
// SSH/registry-push deploy is a config-gated extension of this same
// interface, not implemented — no remote host to verify it against here.
export const dockerComposeProvider: DeployProvider = {
  key: "docker-compose-local",

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const git = simpleGit(ctx.repoRoot);
    const currentBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (currentBranch !== ctx.baseBranch) {
      return { status: "failed", detail: { reason: `repo not on base branch (on "${currentBranch}", expected "${ctx.baseBranch}")` } };
    }

    const status = await git.status();
    if (!status.isClean()) {
      return { status: "failed", detail: { reason: "repo has uncommitted changes, refusing to merge", files: status.files.map((f) => f.path) } };
    }

    try {
      await git.merge(["--no-ff", ctx.worktree.branchName, "-m", `merge: ${ctx.card.title} (card ${ctx.card.id.slice(0, 8)})`]);
    } catch (err) {
      return { status: "failed", detail: { step: "merge", error: (err as Error).message } };
    }
    const mergedSha = (await git.revparse(["HEAD"])).trim();

    const build = await execIn(ctx.repoRoot, "docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build"], 10 * 60 * 1000);
    if (build.code !== 0) {
      return { status: "failed", detail: { step: "docker compose up", code: build.code, stderrTail: build.stderr.slice(-3000) } };
    }

    const health = await pollHealth(ctx, 90 * 1000);
    if (!health.healthy) {
      return { status: "failed", detail: { step: "health check", ...health.detail, deployedCommitSha: mergedSha } };
    }

    return {
      status: "live",
      deployedCommitSha: mergedSha,
      deployUrl: `http://localhost:${process.env.WEB_PORT ?? 3000}`,
      monitoringDashboardUrl: `${API_URL}/health`,
      detail: { build: "ok", health: health.detail },
    };
  },

  async rollback(ctx: DeployContext, toCommitSha: string): Promise<DeployResult> {
    const git = simpleGit(ctx.repoRoot);
    // git revert, not reset --hard: keeps history intact and is itself
    // reversible, rather than discarding commits on the shared base branch.
    try {
      await git.raw(["revert", "--no-edit", "-m", "1", "HEAD"]);
    } catch (err) {
      return { status: "failed", detail: { step: "revert", error: (err as Error).message, toCommitSha } };
    }

    const build = await execIn(ctx.repoRoot, "docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build"], 10 * 60 * 1000);
    if (build.code !== 0) {
      return { status: "failed", detail: { step: "docker compose up (rollback)", code: build.code, stderrTail: build.stderr.slice(-3000) } };
    }

    const health = await pollHealth(ctx, 90 * 1000);
    const revertedSha = (await git.revparse(["HEAD"])).trim();
    return {
      status: health.healthy ? "live" : "failed",
      deployedCommitSha: revertedSha,
      detail: { rolledBackTo: toCommitSha, health: health.detail },
    };
  },

  async healthCheck(ctx: DeployContext): Promise<HealthStatus> {
    return pollHealth(ctx, 5000);
  },
};
