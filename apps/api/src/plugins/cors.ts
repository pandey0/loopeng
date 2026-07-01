import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import cors from "@fastify/cors";

export const corsPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(cors, {
    origin: process.env.NEXT_PUBLIC_API_URL ? true : "*",
  });
});
