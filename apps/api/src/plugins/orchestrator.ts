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
  if (process.env.ORCHESTRATOR_ENABLED !== "1") {
    fastify.log.warn("ORCHESTRATOR_ENABLED is not set to \"1\" -- cron/event dispatch triggers are not running");
    return;
  }

  // Both reconcile sweeps used to run unconditionally, ahead of this check,
  // on the theory that they're data hygiene ("that run died, the card lied
  // about being in_progress") rather than dispatch authority -- so a
  // worktree-local/dispatch-disabled boot should still get the benefit.
  // That was wrong: reconcileOrphanedRuns can't tell "a run whose owning
  // process really did crash" from "a run that's alive right now under a
  // *different, currently-running* process" -- it only looks at
  // agent_runs.status against the shared DB, with no visibility into any
  // other process's in-memory sessionRegistry. A worktree is a full copy of
  // this code pointed at the same DATABASE_URL (see the comment above), so
  // an agent's own worktree booting a dev server for verification would run
  // this sweep, see its *own still-running* implementer run as "orphaned"
  // (nothing about the row looks different from a real orphan), mark it
  // failed, and yank the card back to "ready" out from under the real agent
  // mid-run. Confirmed live on 2026-07-12: 8 of these false-orphan events
  // across 2 days of history, each on a card with a genuinely live run --
  // card 005c04ae's implementer kept working and finished normally 4
  // minutes after being wrongly marked orphaned, then hit
  // "InvalidTransitionError: cannot transition card from ready to
  // in_review" because reconcile had already reset its card state.
  // ORCHESTRATOR_ENABLED is already the exact opt-in boundary that keeps a
  // worktree copy from racing the real instance on dispatch -- reusing it
  // here closes this the same way, at the cost of the one real instance
  // needing ORCHESTRATOR_ENABLED=1 for this sweep to run, which it always
  // does (see start-api.sh).
  const reconciled = await reconcileOrphanedRuns();
  if (reconciled > 0) {
    fastify.log.warn(`reconciled ${reconciled} card(s) orphaned by a prior process restart -> blocked`);
  }

  const requeued = await reconcileRateLimitedCards();
  if (requeued > 0) {
    fastify.log.warn(`requeued ${requeued} card(s) stranded by a rate-limit timer lost to a prior process restart`);
  }

  const orchestrator = await startOrchestrator();
  fastify.decorate("orchestrator", orchestrator);
  fastify.addHook("onClose", async () => {
    await orchestrator.stop();
  });
});
