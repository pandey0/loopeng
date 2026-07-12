import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { reconcileOrphanedRuns, reconcileRateLimitedCards, startOrchestrator, type Orchestrator } from "@loopeng/orchestrator";

declare module "fastify" {
  interface FastifyInstance {
    orchestrator: Orchestrator;
  }
}

// ORCHESTRATOR_ENABLED is an explicit opt-in, not opt-out: every api process
// boots (worktree-local dev servers included) with cron/event dispatch OFF
// by default, and only the one real instance's environment sets it. This is
// load-bearing, not just a nicety -- an implementer agent's worktree checkout
// of apps/api is a full copy of this code pointed at the same DATABASE_URL,
// so an opt-out flag that defaults to "on" means every stray `tsx watch`
// left running inside a worktree silently starts a second orchestrator
// racing the real one over the same card queue (see the 2026-07-02 incident:
// two independent single-worker queues each raced the other into dispatching
// the same ready card into in_progress). Opt-in makes that impossible by
// default -- a worktree process would have to have ORCHESTRATOR_ENABLED=1
// explicitly and deliberately set in its env for this to recur.
export const orchestratorPlugin: FastifyPluginAsync = fp(async (fastify) => {
  // Runs unconditionally, even on a worktree-local/dispatch-disabled boot:
  // this is data hygiene ("that run died, the card lied about being
  // in_progress"), not dispatch authority. Gating it behind
  // ORCHESTRATOR_ENABLED too meant the one instance most likely to inherit
  // an orphan from a *previous* run (a dev box being restarted repeatedly)
  // was also the one instance where the sweep silently never ran.
  const reconciled = await reconcileOrphanedRuns();
  if (reconciled > 0) {
    fastify.log.warn(`reconciled ${reconciled} card(s) orphaned by a prior process restart -> blocked`);
  }

  // Same data-hygiene reasoning as reconcileOrphanedRuns above: a rate-limit
  // retry timer lives only in the process that scheduled it, so any restart
  // between the block and the retry firing strands the card in "blocked"
  // forever with no other trigger to move it. Unconditional for the same
  // reason -- the dev box most likely to inherit a stranded rate-limit
  // block from a *previous* run is also the one where gating this behind
  // ORCHESTRATOR_ENABLED would mean it never runs.
  const requeued = await reconcileRateLimitedCards();
  if (requeued > 0) {
    fastify.log.warn(`requeued ${requeued} card(s) stranded by a rate-limit timer lost to a prior process restart`);
  }

  if (process.env.ORCHESTRATOR_ENABLED !== "1") {
    fastify.log.warn("ORCHESTRATOR_ENABLED is not set to \"1\" -- cron/event dispatch triggers are not running");
    return;
  }
  const orchestrator = await startOrchestrator();
  fastify.decorate("orchestrator", orchestrator);
  fastify.addHook("onClose", async () => {
    await orchestrator.stop();
  });
});
