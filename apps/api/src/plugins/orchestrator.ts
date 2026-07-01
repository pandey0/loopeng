import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { startOrchestrator, type Orchestrator } from "@loopeng/orchestrator";

declare module "fastify" {
  interface FastifyInstance {
    orchestrator: Orchestrator;
  }
}

export const orchestratorPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const orchestrator = await startOrchestrator();
  fastify.decorate("orchestrator", orchestrator);
  fastify.addHook("onClose", async () => {
    await orchestrator.stop();
  });
});
