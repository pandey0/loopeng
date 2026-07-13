import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { agentRuns, db, eventLog, verifyApiKey, type VerifiedActor } from "@loopeng/db";

declare module "fastify" {
  interface FastifyInstance {
    // preHandler for routes that mutate card/board state -- 401s if the
    // caller has no verified identity instead of letting a route fall back
    // to trusting a client-supplied actorType (the exact gap card 438646e5
    // documents: any caller could self-report actorType=user).
    requireActor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    // Same verification as requireActor, plus a class check: 403s anything
    // that isn't a verified actorType=user (browser) caller. Board-shaping
    // actions with no single card to scope to (create a board/project/doc,
    // approve an intake proposal) should only ever be human-initiated --
    // agents and automation act on cards through their own dedicated
    // endpoints, never these.
    requireHumanActor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    // Authorization on top of requireActor's authentication: an
    // actorType=agent caller is only ever authorized for the one card its
    // key was minted for (see cardScopedAgentEnv in @loopeng/agents) --
    // 403s (and writes a card.access_denied event, so the attempt itself is
    // auditable) anything targeting a different :id. No-op for user/
    // automation callers, which aren't scoped to a single card. Must run
    // after requireActor in the same preHandler chain.
    requireOwnCard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

  fastify.decorate("requireHumanActor", async (request: FastifyRequest, reply: FastifyReply) => {
    await fastify.requireActor(request, reply);
    if (reply.sent) return;
    if (request.actor?.type !== "user") {
      reply.status(403).send({ error: "forbidden", message: "this action requires a verified human (browser) caller" });
    }
  });

  fastify.decorate("requireOwnCard", async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.actor;
    if (!actor || actor.type !== "agent" || !actor.id) return;

    const { id: cardId } = request.params as { id?: string };
    if (!cardId) return;

    const [run] = await db.select({ cardId: agentRuns.cardId }).from(agentRuns).where(eq(agentRuns.id, actor.id));
    if (run?.cardId === cardId) return;

    await db.insert(eventLog).values({
      entityType: "card",
      entityId: cardId,
      eventType: "card.access_denied",
      actorType: actor.type,
      actorId: actor.id,
      payload: { attemptedPath: request.url, attemptedMethod: request.method, ownCardId: run?.cardId ?? null },
    });
    reply.status(403).send({ error: "forbidden", message: "this agent-scoped credential is not authorized for this card" });
  });
});
