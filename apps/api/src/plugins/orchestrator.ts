import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { startOrchestrator, type Orchestrator } from "@loopeng/orchestrator";

declare module "fastify" {
  interface FastifyInstance {
    orchestrator: Orchestrator;
  }
}

// ORCHESTRATOR_DISABLED lets the API serve boards/cards/docs CRUD (needed by
// the web app and by direct manual work on main) without cron/event triggers
// dispatching new agent runs -- e.g. while someone is hand-editing files the
// orchestrator would otherwise also be driving agents through.
export const orchestratorPlugin: FastifyPluginAsync = fp(async (fastify) => {
  if (process.env.ORCHESTRATOR_DISABLED === "1") {
    fastify.log.warn("ORCHESTRATOR_DISABLED=1 -- cron/event dispatch triggers are not running");
    return;
  }
  const orchestrator = await startOrchestrator();
  fastify.decorate("orchestrator", orchestrator);
  fastify.addHook("onClose", async () => {
    await orchestrator.stop();
  });
});
