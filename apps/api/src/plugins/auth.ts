import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { verifyApiKey, type VerifiedActor } from "@loopeng/db";

declare module "fastify" {
  interface FastifyInstance {
    // preHandler for routes that mutate card/board state -- 401s if the
    // caller has no verified identity instead of letting a route fall back
    // to trusting a client-supplied actorType (the exact gap card 438646e5
    // documents: any caller could self-report actorType=user).
    requireActor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Set by requireActor once a valid bearer token resolves to a real caller identity. */
    actor?: VerifiedActor;
  }
}

function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export const authPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.decorateRequest("actor", undefined);

  fastify.decorate("requireActor", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization);
    const actor = token ? await verifyApiKey(token) : null;
    if (!actor) {
      reply.status(401).send({ error: "unauthorized", message: "missing or invalid API key" });
      return;
    }
    request.actor = actor;
  });
});
