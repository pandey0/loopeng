import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { BOOT_ID, BOOTED_AT } from "../boot-info.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    try {
      await fastify.db.execute(sql`select 1`);
      // bootId/bootedAt identify *this process instance* -- the deploy
      // pipeline's native-api restart step polls these to confirm a restart
      // actually happened (a new process answering) rather than the same
      // stale process just continuing to pass the DB-connectivity check.
      reply.send({ status: "ok", bootId: BOOT_ID, bootedAt: BOOTED_AT, pid: process.pid });
    } catch (err) {
      reply.status(503).send({ status: "error", message: (err as Error).message, bootId: BOOT_ID, bootedAt: BOOTED_AT, pid: process.pid });
    }
  });
};
