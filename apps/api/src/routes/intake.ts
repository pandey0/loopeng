import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { boards, eventLog } from "@loopeng/db";
import { PlannerOutputError, runPlannerAgent } from "@loopeng/agents";
import { IntakeInputSchema } from "@loopeng/shared";

// Replaces a human manually writing a spec doc + cards: a product owner
// posts a freeform request, the planner agent drafts a spec doc and a
// dependency-linked epic/feature/bug decomposition, and every leaf card
// lands on the board in "backlog" state for a human to review before
// moving it to "ready" — this is an intake tool, not an auto-approval
// bypass. Synchronous by design (mirrors POST /cards/:id/dispatch) — the
// planner is a single bounded CLI call, not a multi-attempt worktree run.
export const intakeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/boards/:id/intake", async (request, reply) => {
    const { id: boardId } = request.params as { id: string };
    const input = IntakeInputSchema.parse({ ...(request.body as object), boardId });

    const [board] = await fastify.db.select().from(boards).where(eq(boards.id, boardId));
    if (!board) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    try {
      const result = await runPlannerAgent(boardId, input.requestText);
      await fastify.db.insert(eventLog).values({
        entityType: "card",
        entityId: result.epicCardId,
        eventType: "card.intake_decomposed",
        actorType: "agent",
        actorId: input.requestedById ?? null,
        payload: { agentRunId: result.agentRunId, cardIds: result.cardIds, specDocId: result.specDocId },
      });
      reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PlannerOutputError) {
        reply.status(422).send({ error: "planner_output_invalid", message: err.message });
        return;
      }
      throw err;
    }
  });
};
