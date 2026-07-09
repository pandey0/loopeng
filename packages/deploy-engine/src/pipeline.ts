import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, deployRecords, gateDefinitions, gateResults } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { getActiveWorktree, teardownWorktree } from "@loopeng/worktree-manager";
import { dockerComposeProvider } from "./providers/docker-compose.js";
import type { DeployProvider } from "./types.js";

function resolveRepoRoot(): string {
  if (process.env.TARGET_REPO_PATH) return process.env.TARGET_REPO_PATH;
  return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
}

async function recordDeployLiveGate(cardId: string, passed: boolean, detail: Record<string, unknown>) {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
  if (!gateDef) {
    console.warn("[deploy-engine] deploy_live gate_definition not seeded, skipping gate_results row");
    return;
  }
  await db.insert(gateResults).values({ cardId, gateDefinitionId: gateDef.id, status: passed ? "passed" : "failed", detail });
}

export interface DeployPipelineResult {
  status: "done" | "deploy_failed";
}

// Runs once a card reaches "deploying" (auto for low/med risk, or after
// human approval for high risk). Merges the worktree branch into base,
// deploys, and health-checks. Live -> done + worktree torn down (merged).
// Unhealthy -> automatic rollback to the pre-merge commit, card ->
// deploy_failed for a human (or automation) to retry the deploy step
// directly without re-running implementer/reviewer/gates, worktree kept
// for inspection.
export async function runDeployPipeline(cardId: string, provider: DeployProvider = dockerComposeProvider): Promise<DeployPipelineResult> {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
  if (!card) throw new Error(`card not found: ${cardId}`);
  if (card.state !== "deploying") {
    throw new Error(`card ${cardId} is not in "deploying" state (state=${card.state}), refusing to deploy`);
  }

  const worktree = await getActiveWorktree(cardId);
  if (!worktree) throw new Error(`no active worktree for card ${cardId}`);

  const repoRoot = resolveRepoRoot();
  const git = simpleGit(repoRoot);
  const baseBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  const preDeploySha = (await git.revparse(["HEAD"])).trim();

  const [deployRecord] = await db
    .insert(deployRecords)
    .values({ cardId, environment: "production", status: "deploying", startedAt: new Date() })
    .returning();
  if (!deployRecord) throw new Error("failed to insert deploy_records row");

  const ctx = { card, worktree, repoRoot, baseBranch };
  const result = await provider.deploy(ctx);

  if (result.status === "live") {
    await db
      .update(deployRecords)
      .set({
        status: "live",
        deployedCommitSha: result.deployedCommitSha,
        deployUrl: result.deployUrl,
        monitoringDashboardUrl: result.monitoringDashboardUrl,
        finishedAt: new Date(),
      })
      .where(eq(deployRecords.id, deployRecord.id));

    await recordDeployLiveGate(cardId, true, result.detail);
    await applyTransition({ cardId, toState: "done", actorType: "automation" });
    await teardownWorktree(worktree.id, "merged");
    return { status: "done" };
  }

  // Deploy failed. Only roll back via git-revert if this run actually
  // created a new commit — otherwise HEAD isn't ours to revert (e.g. the
  // card's branch was already merged in a prior run) and reverting it would
  // discard unrelated history.
  let rollbackDetail: Record<string, unknown> = { skipped: "no new commit was created this run, nothing to revert" };
  if (result.createdNewCommit) {
    const rollback = await provider.rollback(ctx, preDeploySha);
    rollbackDetail = rollback.detail;
    await db
      .update(deployRecords)
      .set({
        status: rollback.status === "live" ? "rolled_back" : "failed",
        deployedCommitSha: rollback.deployedCommitSha,
        finishedAt: new Date(),
      })
      .where(eq(deployRecords.id, deployRecord.id));

    if (rollback.status === "live") {
      await db.insert(deployRecords).values({
        cardId,
        environment: "production",
        status: "rolled_back",
        deployedCommitSha: rollback.deployedCommitSha,
        rollbackOfDeployId: deployRecord.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
  } else {
    await db
      .update(deployRecords)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(deployRecords.id, deployRecord.id));
  }

  await recordDeployLiveGate(cardId, false, { deployFailure: result.detail, rollback: rollbackDetail });
  await applyTransition({ cardId, toState: "deploy_failed", actorType: "automation" });
  return { status: "deploy_failed" };
}

export * from "./types.js";
export { dockerComposeProvider } from "./providers/docker-compose.js";
