import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    try {
      await fastify.db.execute(sql`select 1`);
      reply.send({ status: "ok" });
    } catch (err) {
      reply.status(503).send({ status: "error", message: (err as Error).message });
    }
  });
};
