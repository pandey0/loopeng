import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { db, pool } from "@loopeng/db";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

export const dbPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.decorate("db", db);
  fastify.addHook("onClose", async () => {
    await pool.end();
  });
});
