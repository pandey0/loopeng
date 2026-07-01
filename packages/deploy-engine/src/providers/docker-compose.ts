import { simpleGit } from "simple-git";
import { execIn } from "../exec.js";
import type { DeployContext, DeployProvider, DeployResult, HealthStatus } from "../types.js";

const API_URL = process.env.DEPLOY_HEALTH_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const COMPOSE_FILE = "infrastructure/docker/docker-compose.yml";
// api isn't in this list by default: it shells out to git/docker/claude CLI
// (worktree-manager, deploy-engine itself, packages/agents) which the api
// image doesn't have installed, so api currently must run natively rather
// than containerized — see Dockerfile.api. Rebuilding it here would also
// port-conflict with that native process. Full containerization of the
// agent/deploy runtime (git+docker-cli+claude CLI+docker.sock in the image)
// is tracked as follow-up work, not done in this pass. Configurable via
// DEPLOY_COMPOSE_SERVICES so a fully-containerized setup can opt back in.
const COMPOSE_SERVICES = (process.env.DEPLOY_COMPOSE_SERVICES ?? "web").split(",").map((s) => s.trim());

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
      return { status: "failed", createdNewCommit: false, detail: { reason: `repo not on base branch (on "${currentBranch}", expected "${ctx.baseBranch}")` } };
    }

    const status = await git.status();
    if (!status.isClean()) {
      return { status: "failed", createdNewCommit: false, detail: { reason: "repo has uncommitted changes, refusing to merge", files: status.files.map((f) => f.path) } };
    }

    const preMergeSha = (await git.revparse(["HEAD"])).trim();
    try {
      await git.merge(["--no-ff", ctx.worktree.branchName, "-m", `merge: ${ctx.card.title} (card ${ctx.card.id.slice(0, 8)})`]);
    } catch (err) {
      return { status: "failed", createdNewCommit: false, detail: { step: "merge", error: (err as Error).message } };
    }
    const mergedSha = (await git.revparse(["HEAD"])).trim();
    // Branch was already an ancestor of HEAD (e.g. re-merged after an
    // earlier revert) — --no-ff still no-ops with nothing new to merge.
    // We don't own any new commit here, so a failure below must not trigger
    // a git-revert rollback (nothing safe for us to revert).
    const createdNewCommit = mergedSha !== preMergeSha;

    const build = await execIn(ctx.repoRoot, "docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build", ...COMPOSE_SERVICES], 10 * 60 * 1000);
    if (build.code !== 0) {
      return { status: "failed", createdNewCommit, deployedCommitSha: mergedSha, detail: { step: "docker compose up", code: build.code, stderrTail: build.stderr.slice(-3000) } };
    }

    const health = await pollHealth(ctx, 90 * 1000);
    if (!health.healthy) {
      return { status: "failed", createdNewCommit, deployedCommitSha: mergedSha, detail: { step: "health check", ...health.detail } };
    }

    return {
      status: "live",
      createdNewCommit,
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
      return { status: "failed", createdNewCommit: false, detail: { step: "revert", error: (err as Error).message, toCommitSha } };
    }

    const build = await execIn(ctx.repoRoot, "docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build", ...COMPOSE_SERVICES], 10 * 60 * 1000);
    if (build.code !== 0) {
      return { status: "failed", createdNewCommit: false, detail: { step: "docker compose up (rollback)", code: build.code, stderrTail: build.stderr.slice(-3000) } };
    }

    const health = await pollHealth(ctx, 90 * 1000);
    const revertedSha = (await git.revparse(["HEAD"])).trim();
    return {
      status: health.healthy ? "live" : "failed",
      createdNewCommit: false,
      deployedCommitSha: revertedSha,
      detail: { rolledBackTo: toCommitSha, health: health.detail },
    };
  },

  async healthCheck(ctx: DeployContext): Promise<HealthStatus> {
    return pollHealth(ctx, 5000);
  },
};
