import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { startOrchestrator, type Orchestrator } from "@loopeng/orchestrator";

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
  const orchestrator = await startOrchestrator();
  fastify.decorate("orchestrator", orchestrator);
  fastify.addHook("onClose", async () => {
    await orchestrator.stop();
  });
});
