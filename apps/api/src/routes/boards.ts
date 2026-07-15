import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cards } from "@loopeng/db";
import { BoardSchema } from "@loopeng/shared";
import { z } from "zod";

const CreateBoardSchema = BoardSchema.pick({ name: true, description: true }).partial({
  description: true,
});

export const boardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/boards", async (request) => {
    return fastify.db.select().from(boards);
  });

  fastify.post("/boards", { preHandler: fastify.requireHumanActor }, async (request, reply) => {
    const input = CreateBoardSchema.parse(request.body);
    const [board] = await fastify.db.insert(boards).values(input).returning();
    reply.status(201).send(board);
  });

  fastify.get("/boards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [board] = await fastify.db.select().from(boards).where(eq(boards.id, id));
    if (!board) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    const boardCards = await fastify.db.select().from(cards).where(eq(cards.boardId, id));
    return { ...board, cards: boardCards };
  });
};
