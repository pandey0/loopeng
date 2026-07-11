import fp from "fastify-plugin";
import type { FastifyError, FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { ConcurrentTransitionError, InvalidTransitionError } from "@loopeng/board-engine";

export const errorHandlerPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: "validation_error", issues: error.issues });
      return;
    }
    if (error instanceof InvalidTransitionError) {
      reply.status(409).send({ error: "invalid_transition", message: error.message });
      return;
    }
    if (error instanceof ConcurrentTransitionError) {
      reply.status(409).send({ error: "concurrent_transition", message: error.message });
      return;
    }
    fastify.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      error: "internal_error",
      message: error.message,
    });
  });
});
