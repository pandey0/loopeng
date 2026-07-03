import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { dbPlugin } from "./plugins/db.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { corsPlugin } from "./plugins/cors.js";
import { orchestratorPlugin } from "./plugins/orchestrator.js";
import { healthRoutes } from "./routes/health.js";
import { docRoutes } from "./routes/docs.js";
import { boardRoutes } from "./routes/boards.js";
import { cardRoutes } from "./routes/cards.js";
import { eventRoutes } from "./routes/events.js";
import { intakeRoutes } from "./routes/intake.js";
import { agentRunSocketRoutes } from "./routes/agent-run-socket.js";

const fastify = Fastify({ logger: true });

await fastify.register(corsPlugin);
await fastify.register(dbPlugin);
await fastify.register(errorHandlerPlugin);
await fastify.register(orchestratorPlugin);
await fastify.register(websocketPlugin);
await fastify.register(healthRoutes);
await fastify.register(docRoutes);
await fastify.register(boardRoutes);
await fastify.register(cardRoutes);
await fastify.register(eventRoutes);
await fastify.register(intakeRoutes);
await fastify.register(agentRunSocketRoutes);

const port = Number(process.env.API_PORT ?? 4000);

fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`api listening on ${port}`))
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
