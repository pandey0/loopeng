import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { boards, eventLog } from "@loopeng/db";
import { PlannerOutputError, startPlannerAgent, type PlannerRunResult } from "@loopeng/agents";
import { IntakeInputSchema } from "@loopeng/shared";

export type IntakeStatusResponse =
  | { status: "running" }
  | { status: "succeeded"; result: { agentRunId: string; epicCardId: string; cardIds: string[]; specDocId: string } }
  | { status: "failed"; error: string; code?: "planner_output_invalid" };

type IntakeOutcome =
  | { status: "running" }
  | { status: "succeeded"; result: PlannerRunResult }
  | { status: "failed"; error: string; code?: "planner_output_invalid" };

// Process-local map from agentRunId to how its background intake run ended,
// mirroring the sessionRegistry pattern in claude-cli.ts (Phase 1 is a
// single-node deployment, so in-memory is an acceptable substitute for a
// persisted result store here too).
const intakeOutcomes = new Map<string, IntakeOutcome>();

// Replaces a human manually writing a spec doc + cards: a product owner
// posts a freeform request, the planner agent drafts a spec doc and a
// dependency-linked epic/feature/bug decomposition, and every leaf card
// lands on the board in "backlog" state for a human to review before
// moving it to "ready" — this is an intake tool, not an auto-approval
// bypass.
//
// The planner CLI call + output parsing + board persistence can take tens of
// seconds, so this responds as soon as the agent_runs row exists (202 with
// just agentRunId) and continues the rest as a detached background task —
// the frontend attaches AgentSessionPanel's live socket to that id instead of
// blocking on a spinner, then polls GET .../intake/:agentRunId for the final
// result once the run finishes.
export const intakeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/boards/:id/intake", async (request, reply) => {
    const { id: boardId } = request.params as { id: string };
    const input = IntakeInputSchema.parse({ ...(request.body as object), boardId });

    const [board] = await fastify.db.select().from(boards).where(eq(boards.id, boardId));
    if (!board) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    const { agentRunId, result } = await startPlannerAgent(boardId, input.requestText);
    intakeOutcomes.set(agentRunId, { status: "running" });

    // Not awaited: the whole point is the HTTP response doesn't wait on this.
    // Every branch below still records a terminal outcome, so a background
    // failure surfaces through polling instead of becoming an unhandled
    // rejection or a request that hangs forever.
    result
      .then(async (r) => {
        await fastify.db.insert(eventLog).values({
          entityType: "card",
          entityId: r.epicCardId,
          eventType: "card.intake_decomposed",
          actorType: "agent",
          actorId: input.requestedById ?? null,
          payload: { agentRunId: r.agentRunId, cardIds: r.cardIds, specDocId: r.specDocId },
        });
        intakeOutcomes.set(agentRunId, { status: "succeeded", result: r });
      })
      .catch((err) => {
        const code = err instanceof PlannerOutputError ? "planner_output_invalid" : undefined;
        const message = err instanceof Error ? err.message : String(err);
        intakeOutcomes.set(agentRunId, { status: "failed", error: message, code });
      });

    reply.status(202).send({ agentRunId });
  });

  fastify.get("/boards/:id/intake/:agentRunId", async (request, reply) => {
    const { agentRunId } = request.params as { id: string; agentRunId: string };
    const outcome = intakeOutcomes.get(agentRunId);
    if (!outcome) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    if (outcome.status === "running") {
      reply.status(200).send({ status: "running" } satisfies IntakeStatusResponse);
      return;
    }
    if (outcome.status === "succeeded") {
      const { agentRunId: id, epicCardId, cardIds, specDocId } = outcome.result;
      reply.status(200).send({ status: "succeeded", result: { agentRunId: id, epicCardId, cardIds, specDocId } } satisfies IntakeStatusResponse);
      return;
    }
    reply.status(200).send({ status: "failed", error: outcome.error, code: outcome.code } satisfies IntakeStatusResponse);
  });
};
