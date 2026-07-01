import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { applyTransition, wouldCreateCycle } from "@loopeng/board-engine";
import { cardDependencies, cardDocLinks, cards } from "@loopeng/db";
import {
  CardCreateInputSchema,
  CardTransitionInputSchema,
  CardUpdateInputSchema,
  CardDependencySchema,
  CardDocLinkSchema,
} from "@loopeng/shared";

export const cardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/cards", async (request) => {
    const { boardId } = request.query as { boardId?: string };
    if (boardId) {
      return fastify.db.select().from(cards).where(eq(cards.boardId, boardId));
    }
    return fastify.db.select().from(cards);
  });

  fastify.post("/cards", async (request, reply) => {
    const input = CardCreateInputSchema.parse(request.body);
    const [card] = await fastify.db.insert(cards).values(input).returning();
    reply.status(201).send(card);
  });

  fastify.get("/cards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [card] = await fastify.db.select().from(cards).where(eq(cards.id, id));
    if (!card) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    return card;
  });

  fastify.patch("/cards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardUpdateInputSchema.parse(request.body);
    const [card] = await fastify.db
      .update(cards)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    if (!card) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    return card;
  });

  fastify.get("/cards/:id/detail", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [card] = await fastify.db.select().from(cards).where(eq(cards.id, id));
    if (!card) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    const [dependsOn, dependents, docLinks] = await Promise.all([
      fastify.db.select().from(cardDependencies).where(eq(cardDependencies.cardId, id)),
      fastify.db.select().from(cardDependencies).where(eq(cardDependencies.dependsOnCardId, id)),
      fastify.db.select().from(cardDocLinks).where(eq(cardDocLinks.cardId, id)),
    ]);
    return { ...card, dependsOn, dependents, docLinks };
  });

  fastify.post("/cards/:id/transition", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardTransitionInputSchema.parse(request.body);
    const card = await applyTransition({ cardId: id, ...input });
    reply.send(card);
  });

  // Manual trigger for the Phase 2 autonomous loop — normally cron/event
  // triggers dispatch cards automatically, but this lets a human (or a
  // test) force a specific ready card through implementer -> reviewer ->
  // gate_checks without waiting for a schedule.
  fastify.post("/cards/:id/dispatch", async (request, reply) => {
    const { id } = request.params as { id: string };
    await fastify.orchestrator.coordination.dispatch(id);
    reply.status(202).send({ dispatched: id });
  });

  fastify.post("/cards/:id/dependencies", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardDependencySchema.omit({ cardId: true }).parse(request.body);

    if (input.dependencyType === "blocks" || !input.dependencyType) {
      const wouldCycle = await wouldCreateCycle(id, input.dependsOnCardId);
      if (wouldCycle) {
        reply.status(409).send({ error: "cycle_detected", message: "this dependency would create a cycle" });
        return;
      }
    }

    const [edge] = await fastify.db
      .insert(cardDependencies)
      .values({ cardId: id, dependsOnCardId: input.dependsOnCardId, dependencyType: input.dependencyType })
      .returning();
    reply.status(201).send(edge);
  });

  fastify.get("/cards/:id/dependencies", async (request) => {
    const { id } = request.params as { id: string };
    return fastify.db.select().from(cardDependencies).where(eq(cardDependencies.cardId, id));
  });

  fastify.post("/cards/:id/doc-links", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardDocLinkSchema.omit({ cardId: true }).parse(request.body);
    const [link] = await fastify.db
      .insert(cardDocLinks)
      .values({ cardId: id, docId: input.docId, linkType: input.linkType })
      .returning();
    reply.status(201).send(link);
  });

  fastify.get("/cards/:id/doc-links", async (request) => {
    const { id } = request.params as { id: string };
    return fastify.db.select().from(cardDocLinks).where(eq(cardDocLinks.cardId, id));
  });
};
