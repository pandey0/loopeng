import { simpleGit } from "simple-git";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, deployRecords, gateDefinitions, gateResults } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { getActiveWorktree, InvalidRepoError, resolveRepoRootForCard, teardownWorktree } from "@loopeng/worktree-manager";
import { acquireDeployLock, DeployLockError } from "./lock.js";
import { dockerComposeProvider } from "./providers/docker-compose.js";
import type { DeployProvider } from "./types.js";

async function recordRepoValidGate(cardId: string, passed: boolean, detail: Record<string, unknown>) {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "repo_valid"));
  if (!gateDef) {
    console.warn("[deploy-engine] repo_valid gate_definition not seeded, skipping gate_results row");
    return;
  }
  await db.insert(gateResults).values({ cardId, gateDefinitionId: gateDef.id, status: passed ? "passed" : "failed", detail });
}

// Health dashboard (apps/api/src/routes/deploys.ts) reads deploy_live
// gate_results as its only source of "recent deploy attempts", including
// in-progress ones -- so a deploy's lifecycle must show up as a "running" row
// the moment it starts, not just as a passed/failed row once it finishes.
async function recordDeployLiveGate(
  cardId: string,
  status: "running" | "passed" | "failed",
  detail: Record<string, unknown>,
): Promise<string | undefined> {
  const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
  if (!gateDef) {
    console.warn("[deploy-engine] deploy_live gate_definition not seeded, skipping gate_results row");
    return undefined;
  }
  const [row] = await db.insert(gateResults).values({ cardId, gateDefinitionId: gateDef.id, status, detail }).returning({ id: gateResults.id });
  return row?.id;
}

async function finishDeployLiveGate(gateResultId: string | undefined, status: "passed" | "failed", detail: Record<string, unknown>): Promise<void> {
  // gateResultId is undefined only when the gate_definition wasn't seeded --
  // recordDeployLiveGate already warned about that, nothing to update here.
  if (!gateResultId) return;
  // computeBlockedReasons (board-engine/card-status.ts) and the health
  // dashboard both order gate_results by createdAt desc to find the most
  // recent outcome -- bump it here so it reflects when the deploy actually
  // resolved, not when the "running" row was first inserted (which could be
  // long before, for a slow deploy).
  await db.update(gateResults).set({ status, detail, createdAt: new Date() }).where(eq(gateResults.id, gateResultId));
}

export interface DeployPipelineResult {
  status: "done" | "deploy_failed";
}

// A deploy_records row left in status "deploying" only ever means one of two
// things: another deploy for this card is actively running right now, or a
// previous run crashed mid-deploy (disk-full, OOM kill, host reboot) before
// it could write "live"/"failed". By the time this runs we're holding the
// per-target advisory lock, which rules out the first case -- so any row
// still "deploying" here is provably a crash leftover, not a live run. Mark
// it "crashed" so deploy_records always reflects reality instead of lying
// about an attempt that's still "in progress" long after the process that
// ran it is gone -- the whole point being nobody has to open a DB client and
// UPDATE this by hand to figure out what actually happened.
async function reconcileCrashedDeploys(cardId: string): Promise<void> {
  const stale = await db
    .update(deployRecords)
    .set({ status: "crashed", finishedAt: new Date() })
    .where(and(eq(deployRecords.cardId, cardId), eq(deployRecords.status, "deploying")))
    .returning({ id: deployRecords.id });

  if (stale.length > 0) {
    const detail = {
      reason: "recovered from a crashed deploy attempt (process died mid-deploy, holding no lock)",
      crashedDeployRecordIds: stale.map((r) => r.id),
    };

    // The crashed attempt's own deploy_live gate_results row (inserted as
    // "running" when it started) never got a terminal update -- finalize it
    // in place, the same way a normal finish does, instead of inserting a
    // second row for the same attempt (which would show one crashed deploy
    // as two separate "recent attempts" on the health dashboard).
    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
    const updated = gateDef
      ? await db
          .update(gateResults)
          .set({ status: "failed", detail, createdAt: new Date() })
          .where(and(eq(gateResults.cardId, cardId), eq(gateResults.gateDefinitionId, gateDef.id), eq(gateResults.status, "running")))
          .returning({ id: gateResults.id })
      : [];

    // No "running" row to finalize (gate wasn't seeded when the crashed
    // attempt started) -- still record the failure so it's not lost.
    if (updated.length === 0) {
      await recordDeployLiveGate(cardId, "failed", detail);
    }
  }
}

// reconcileCrashedDeploys above only runs *reactively*, at the top of a
// fresh runDeployPipeline call for the same card -- which requires a new
// card.moved "-> deploying" event to fire it. A card already sitting in
// "deploying" when the process that was running its deploy dies (an api
// restart, a crash) never gets one: nothing re-enters "deploying" from
// "deploying" itself, so that reactive check never gets a chance to run,
// and the card is stuck there forever with no error, no retry button, and
// no visible reason -- worse than deploy_failed, since a human looking at
// the board sees "deploying" and reasonably assumes something is still
// happening. Confirmed live on 2026-07-15: a card sat in "deploying" for
// 29+ minutes after an unrelated api restart orphaned its deploy attempt.
//
// Runs once at boot (see apps/api's orchestrator plugin), same shape as
// reconcileOrphanedRuns/reconcileRateLimitedCards: at boot, ANY card still
// in "deploying" is provably orphaned, full stop -- runDeployPipeline runs
// entirely in-process (no separate persistent worker), so nothing about a
// live deploy can survive this process restarting. This isn't limited to
// cards whose deploy_records row also says "deploying": a first real
// attempt can die even earlier than that insert (worktree/repo resolution,
// acquiring the deploy lock), leaving no deploy_records row at all --
// confirmed live on 2026-07-15, a card stuck in "deploying" for 8+ minutes
// with zero deploy_records rows for that attempt. reconcileCrashedDeploys
// is still called to finalize whatever *does* exist (a crash leftover row,
// if one was written); it safely no-ops if there's nothing to reconcile.
// Either way the card moves to deploy_failed so a human can retry the
// deploy step directly -- deploy_failed -> deploying skips
// implementer/reviewer/gates entirely, so this doesn't cost a re-run of
// any of that, only the deploy step itself.
export async function reconcileStuckDeploys(): Promise<number> {
  const stuckCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.state, "deploying"));

  for (const card of stuckCards) {
    await reconcileCrashedDeploys(card.id);
    await applyTransition({
      cardId: card.id,
      toState: "deploy_failed",
      actorType: "automation",
      reason: "deploy attempt was orphaned by a process restart -- recovered at boot, retry the deploy step whenever ready",
    });
  }

  return stuckCards.length;
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

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRootForCard(cardId);
  } catch (err) {
    // The project's repo can go missing/invalid any time between worktree
    // creation and deploy (e.g. .git deleted). Same failure class as the
    // pre-worktree check in the orchestrator loop -- must not throw
    // uncaught, since that would just get swallowed by the event-trigger's
    // bare .catch(console.error) and leave the card stuck in "deploying"
    // forever with no blockedReason.
    const reason = err instanceof InvalidRepoError ? err.message : `repo resolution failed: ${(err as Error).message}`;
    await recordRepoValidGate(cardId, false, { reason });
    // Same reasoning as every other failure below: nothing about the
    // implementer/reviewer/gates work is wrong here, only the deploy-time
    // repo resolution -- deploy_failed lets a retry skip straight back to
    // "deploying" once the repo is fixed, instead of forcing the full cycle.
    await applyTransition({ cardId, toState: "deploy_failed", actorType: "automation", reason });
    return { status: "deploy_failed" };
  }
  // Only one deploy may run against a given target (its repo root -- the
  // shared base-branch checkout and the docker-compose project both
  // `deploy()` and `rollback()` mutate) at a time: a manual deploy and an
  // automated one racing `docker compose up` against the same service is
  // exactly the container-name-conflict incident this lock exists to
  // prevent. Non-blocking, so a losing call fails fast with a clear error
  // instead of hanging behind the winner.
  let lock;
  try {
    lock = await acquireDeployLock(repoRoot);
  } catch (err) {
    if (!(err instanceof DeployLockError)) throw err;
    const [deployRecord] = await db
      .insert(deployRecords)
      .values({ cardId, environment: "production", status: "failed", startedAt: new Date(), finishedAt: new Date() })
      .returning();
    await recordDeployLiveGate(cardId, "failed", { reason: err.message, deployRecordId: deployRecord?.id });
    await applyTransition({ cardId, toState: "deploy_failed", actorType: "automation", reason: err.message });
    return { status: "deploy_failed" };
  }

  try {
    // Holding the lock proves no other run is active for this target right
    // now, so any deploy_records row still "deploying" here can only be a
    // crash leftover -- reconcile it before starting a fresh attempt.
    await reconcileCrashedDeploys(cardId);

    const git = simpleGit(repoRoot);
    const baseBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    const preDeploySha = (await git.revparse(["HEAD"])).trim();

    const [deployRecord] = await db
      .insert(deployRecords)
      .values({ cardId, environment: "production", status: "deploying", startedAt: new Date() })
      .returning();
    if (!deployRecord) throw new Error("failed to insert deploy_records row");

    // Written before provider.deploy() runs (which can take a while) so the
    // health dashboard shows this attempt as "running" for its whole
    // duration instead of only appearing once it's already finished.
    const deployLiveGateResultId = await recordDeployLiveGate(cardId, "running", { deployRecordId: deployRecord.id });

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

      await finishDeployLiveGate(deployLiveGateResultId, "passed", result.detail);
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

    await finishDeployLiveGate(deployLiveGateResultId, "failed", { deployFailure: result.detail, rollback: rollbackDetail });
    await applyTransition({
      cardId,
      toState: "deploy_failed",
      actorType: "automation",
      reason: `deploy failed: ${JSON.stringify(result.detail).slice(0, 300)}`,
    });
    return { status: "deploy_failed" };
  } finally {
    // Always released, even on an uncaught throw -- a held lock a crash
    // couldn't release here would need a human to clear it manually, exactly
    // the failure mode this lock exists to avoid. (Belt-and-braces: the
    // underlying advisory lock is also session-scoped and auto-released by
    // Postgres if the process dies before even reaching this finally.)
    await lock.release();
  }
}

export * from "./types.js";
export { dockerComposeProvider } from "./providers/docker-compose.js";
