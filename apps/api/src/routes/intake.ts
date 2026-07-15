import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { agentRoles, agentRuns, boards, eventLog } from "@loopeng/db";
import {
  approvePlannerPlan,
  extractResultEventForApi,
  parsePlannerOutput,
  PlannerOutputError,
  runManagerAgent,
  startPlannerAgent,
  type PlannerProposal,
} from "@loopeng/agents";
import { IntakeInputSchema } from "@loopeng/shared";

export type IntakeStatusResponse =
  | { status: "running" }
  | { status: "awaiting_approval"; proposal: PlannerProposal }
  | {
      status: "succeeded";
      result: {
        agentRunId: string;
        epicCardId: string;
        cardIds: string[];
        specDocId: string;
        managerAgentRunId?: string;
        // True until the background manager review (kicked off, unawaited,
        // right after approval below) either confirms or replaces this
        // decomposition. persistManagerDecomposition can delete these exact
        // cardIds and insert a fresh set under new ids -- so a caller that
        // treats these ids as final the moment they see them (the approve
        // response, a card-highlight deep link, a human copying an id out of
        // a chat reply) can end up holding dead references seconds later
        // with nothing telling it that happened. Poll status again while
        // this is true; once it's false, cardIds is the settled, real
        // result of that review (unchanged or replaced either way).
        pendingManagerReview: boolean;
      };
    }
  | { status: "failed"; error: string; code?: "planner_output_invalid" };

// Replaces a human manually writing a spec doc + cards: a product owner
// describes a request in a conversation with the planner agent (it may ask
// clarifying questions first -- see buildPlannerPrompt), and once it proposes
// a breakdown, the product owner reviews it and explicitly approves before
// anything real lands on the board. Nothing here is in-memory-only: every
// planning session's transcript is durable (agent_runs.transcript), its
// status is durable (agent_runs.status), and once approved, which cards it
// produced is durable too (the card.intake_decomposed event below) -- a
// session survives an api restart or the product owner navigating away and
// coming back, by design (this used to be a process-local Map that lost
// everything on restart).
export const intakeRoutes: FastifyPluginAsync = async (fastify) => {
  // Every past and current planning session for this board, most recent
  // first -- the persisted "chat history" list.
  fastify.get("/boards/:id/intake", async (request) => {
    const { id: boardId } = request.params as { id: string };
    const rows = await fastify.db
      .select({ id: agentRuns.id, status: agentRuns.status, startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt })
      .from(agentRuns)
      .innerJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
      .where(and(eq(agentRuns.boardId, boardId), eq(agentRoles.name, "planner")))
      .orderBy(desc(agentRuns.startedAt));
    return rows;
  });

  fastify.post("/boards/:id/intake", { preHandler: fastify.requireHumanActor }, async (request, reply) => {
    const { id: boardId } = request.params as { id: string };
    const input = IntakeInputSchema.parse({ ...(request.body as object), boardId });

    const [board] = await fastify.db.select().from(boards).where(eq(boards.id, boardId));
    if (!board) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    const { agentRunId, result } = await startPlannerAgent(boardId, input.requestText);
    // Not awaited -- agentRuns.status is updated internally by
    // executePlannerAgent as the conversation progresses/finishes, which is
    // what GET .../intake/:agentRunId reads. This catch only exists so a
    // background failure doesn't surface as an unhandled rejection; the
    // failure itself is already recorded (status=failed) by the executor.
    result.catch((err) => console.error(`[intake] planner run ${agentRunId} ended in error:`, err));

    reply.status(202).send({ agentRunId });
  });

  fastify.get("/boards/:id/intake/:agentRunId", async (request, reply) => {
    const { agentRunId } = request.params as { id: string; agentRunId: string };
    const [run] = await fastify.db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
    if (!run) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    if (run.status === "running" || run.status === "queued") {
      reply.status(200).send({ status: "running" } satisfies IntakeStatusResponse);
      return;
    }

    if (run.status === "awaiting_approval") {
      const lastResult = extractResultEventForApi(run.transcript);
      if (!lastResult) {
        reply.status(200).send({ status: "failed", error: "no proposal found in transcript" } satisfies IntakeStatusResponse);
        return;
      }
      try {
        const parsed = parsePlannerOutput(lastResult);
        reply.status(200).send({
          status: "awaiting_approval",
          proposal: {
            specTitle: parsed.decomposition.epic.title,
            cardCount: parsed.decomposition.cards.length,
            cards: parsed.decomposition.cards.map((c) => ({ title: c.title, cardType: c.cardType, riskTier: c.riskTier })),
          },
        } satisfies IntakeStatusResponse);
      } catch (err) {
        reply.status(200).send({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          code: "planner_output_invalid",
        } satisfies IntakeStatusResponse);
      }
      return;
    }

    if (run.status === "succeeded") {
      // Durable, not the in-memory map this used to be: the same event
      // approvePlannerPlan's caller (POST .../approve below) already writes.
      const [decomposedEvent] = await fastify.db
        .select()
        .from(eventLog)
        .where(and(eq(eventLog.eventType, "card.intake_decomposed"), sql`${eventLog.payload}->>'agentRunId' = ${agentRunId}`))
        .limit(1);
      if (!decomposedEvent) {
        reply.status(200).send({ status: "failed", error: "approved but no record of what was created" } satisfies IntakeStatusResponse);
        return;
      }
      const payload = decomposedEvent.payload as { epicCardId: string; cardIds: string[]; specDocId: string };
      const [reviewedEvent] = await fastify.db
        .select()
        .from(eventLog)
        .where(and(eq(eventLog.eventType, "card.epic_reviewed"), eq(eventLog.entityId, payload.epicCardId)))
        .orderBy(desc(eventLog.id))
        .limit(1);
      const reviewedPayload = reviewedEvent?.payload as { agentRunId: string; cardIds: string[] } | undefined;
      reply.status(200).send({
        status: "succeeded",
        result: {
          agentRunId,
          epicCardId: payload.epicCardId,
          cardIds: reviewedPayload?.cardIds ?? payload.cardIds,
          specDocId: payload.specDocId,
          managerAgentRunId: reviewedPayload?.agentRunId,
          pendingManagerReview: !reviewedEvent,
        },
      } satisfies IntakeStatusResponse);
      return;
    }

    // failed
    const lastResult = extractResultEventForApi(run.transcript);
    reply.status(200).send({
      status: "failed",
      error: lastResult ? lastResult.slice(0, 2000) : "planner run failed",
    } satisfies IntakeStatusResponse);
  });

  // The explicit human checkpoint: nothing from a planning conversation
  // exists on the board until this is called. Persists the epic + child
  // cards + spec doc (re-parsed from the same durable transcript the
  // proposal came from, not held in memory), then kicks off the same
  // one-time manager review intake always did -- not awaited, same reasoning
  // as before: the response shouldn't block on a second agent run when the
  // real cards already exist and are visible on the board immediately.
  fastify.post("/boards/:id/intake/:agentRunId/approve", { preHandler: fastify.requireHumanActor }, async (request, reply) => {
    const { id: boardId, agentRunId } = request.params as { id: string; agentRunId: string };
    const actor = request.actor!;

    let persisted: Awaited<ReturnType<typeof approvePlannerPlan>>;
    try {
      persisted = await approvePlannerPlan(agentRunId, boardId);
    } catch (err) {
      const code = err instanceof PlannerOutputError ? "planner_output_invalid" : undefined;
      reply.status(400).send({ error: "approve_failed", message: err instanceof Error ? err.message : String(err), code });
      return;
    }

    // actorType/actorId come from the verified caller (requireHumanActor
    // guarantees actorType=user here), never hardcoded -- this is the same
    // card-creation path the 2026-07-03 incident (card 438646e5) exploited
    // elsewhere: an unauthenticated POST that silently recorded a hardcoded
    // "user" attribution regardless of who actually called it.
    await fastify.db.insert(eventLog).values({
      entityType: "card",
      entityId: persisted.epicCardId,
      eventType: "card.intake_decomposed",
      actorType: actor.type,
      actorId: actor.id,
      payload: { agentRunId: persisted.agentRunId, epicCardId: persisted.epicCardId, cardIds: persisted.cardIds, specDocId: persisted.specDocId },
    });

    runManagerAgent(persisted.epicCardId)
      .then(async (managerResult) => {
        await fastify.db.insert(eventLog).values({
          entityType: "card",
          entityId: persisted.epicCardId,
          eventType: "card.epic_reviewed",
          actorType: "agent",
          payload: { agentRunId: managerResult.agentRunId, cardIds: managerResult.cardIds, removedCardIds: managerResult.removedCardIds },
        });
      })
      .catch((err) => console.error("[intake] manager review failed, keeping planner's original decomposition", err));

    reply.status(200).send({
      status: "succeeded",
      result: {
        agentRunId: persisted.agentRunId,
        epicCardId: persisted.epicCardId,
        cardIds: persisted.cardIds,
        specDocId: persisted.specDocId,
        // The manager review just kicked off above hasn't resolved yet --
        // these are this instant's real ids, but persistManagerDecomposition
        // can still delete and replace them. See IntakeStatusResponse's
        // comment: don't treat these as final, poll the GET status endpoint
        // until pendingManagerReview clears.
        pendingManagerReview: true,
      },
    } satisfies IntakeStatusResponse);
  });
};
