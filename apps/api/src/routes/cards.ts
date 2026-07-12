import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  advanceCardState,
  applyTransition,
  attachCardStatus,
  CardNotFoundError,
  TerminalColumnError,
  wouldCreateCycle,
} from "@loopeng/board-engine";
import { getSessionSnippet, sessionRegistry } from "@loopeng/agents";
import { getActiveWorktree, getRepoDiff } from "@loopeng/worktree-manager";
import {
  agentRoles,
  agentRuns,
  cardDependencies,
  cardDocLinks,
  cardQuestions,
  cards,
  docs,
  eventLog,
  gateDefinitions,
  gateResults,
} from "@loopeng/db";
import {
  AnswerCardQuestionInputSchema,
  CardCreateInputSchema,
  CardTransitionInputSchema,
  CardUpdateInputSchema,
  CardDependencySchema,
  CardDocLinkSchema,
} from "@loopeng/shared";

// "live" = card C's in-process registry has an attachable streaming session
// for this run right now, i.e. a WebSocket client could connect and steer it.
const isRunLive = (agentRunId: string): boolean => sessionRegistry.get(agentRunId) !== undefined;

export const cardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/cards", async (request) => {
    const { boardId } = request.query as { boardId?: string };
    const cardRows = boardId
      ? await fastify.db.select().from(cards).where(eq(cards.boardId, boardId))
      : await fastify.db.select().from(cards);
    return attachCardStatus(cardRows, { isRunLive, getSnippet: getSessionSnippet });
  });

  fastify.post("/cards", async (request, reply) => {
    const { specDocId, ...cardInput } = CardCreateInputSchema.parse(request.body);

    const [specDoc] = await fastify.db.select({ id: docs.id }).from(docs).where(eq(docs.id, specDocId));
    if (!specDoc) {
      reply.status(422).send({ error: "spec_doc_not_found", message: `no doc exists with id ${specDocId}` });
      return;
    }

    // Insert card + spec link together so a card can never exist without the
    // link that docs_adr_linked will require of it anyway -- no window where
    // a half-created card sits linkless if the process dies between the two.
    const card = await fastify.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(cards).values(cardInput).returning();
      if (!inserted) throw new Error("card insert returned no row");
      await tx.insert(cardDocLinks).values({ cardId: inserted.id, docId: specDocId, linkType: "spec" });
      return inserted;
    });

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
    const [dependsOn, dependents, linkedDocs, agentRunRows, gateResultRows, events, questions] = await Promise.all([
      fastify.db.select().from(cardDependencies).where(eq(cardDependencies.cardId, id)),
      fastify.db.select().from(cardDependencies).where(eq(cardDependencies.dependsOnCardId, id)),
      fastify.db
        .select({
          docId: docs.id,
          slug: docs.slug,
          title: docs.title,
          docType: docs.docType,
          linkType: cardDocLinks.linkType,
        })
        .from(cardDocLinks)
        .innerJoin(docs, eq(cardDocLinks.docId, docs.id))
        .where(eq(cardDocLinks.cardId, id)),
      fastify.db
        .select({
          id: agentRuns.id,
          parentAgentRunId: agentRuns.parentAgentRunId,
          roleName: agentRoles.name,
          status: agentRuns.status,
          verdict: agentRuns.verdict,
          startedAt: agentRuns.startedAt,
          finishedAt: agentRuns.finishedAt,
        })
        .from(agentRuns)
        .leftJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
        .where(eq(agentRuns.cardId, id))
        .orderBy(agentRuns.startedAt),
      fastify.db
        .select({
          id: gateResults.id,
          key: gateDefinitions.key,
          name: gateDefinitions.name,
          status: gateResults.status,
          detail: gateResults.detail,
          createdAt: gateResults.createdAt,
          // The exact agent run that produced this result -- lets the client
          // link "this gate passed" straight to the real transcript that
          // verified it, instead of a checkmark asking to be trusted blind.
          runByAgentRunId: gateResults.runByAgentRunId,
        })
        .from(gateResults)
        .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
        .where(eq(gateResults.cardId, id))
        .orderBy(gateResults.createdAt),
      fastify.db
        .select()
        .from(eventLog)
        .where(and(eq(eventLog.entityType, "card"), eq(eventLog.entityId, id)))
        .orderBy(desc(eventLog.id)),
      fastify.db.select().from(cardQuestions).where(eq(cardQuestions.cardId, id)).orderBy(desc(cardQuestions.createdAt)),
    ]);

    return {
      ...card,
      dependsOn,
      dependents,
      linkedDocs,
      agentRuns: agentRunRows.map((run) => ({ ...run, live: isRunLive(run.id) })),
      gateResults: gateResultRows,
      events,
      questions,
    };
  });

  // Lets a human reviewing an awaiting_approval card see the actual diff
  // instead of approving blind -- the same diff the reviewer agent judged,
  // via getRepoDiff/getActiveWorktree already used to build the reviewer's
  // own prompt (packages/agents/src/roles.ts runReviewerAgent).
  fastify.get("/cards/:id/diff", async (request, reply) => {
    const { id } = request.params as { id: string };
    const worktree = await getActiveWorktree(id);
    if (!worktree) {
      reply.status(404).send({ error: "not_found", message: "no active worktree for this card" });
      return;
    }
    const diff = await getRepoDiff(worktree.fsPath, worktree.baseCommitSha);
    return { diff };
  });

  fastify.post("/cards/:id/transition", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardTransitionInputSchema.parse(request.body);
    const card = await applyTransition({ cardId: id, ...input });
    reply.send(card);
  });

  // Advances a card to the next column in the board's ordered column list
  // (packages/shared BOARD_COLUMN_ORDER), through the same applyTransition
  // path drag-and-drop uses -- so orchestrator triggers and card.moved
  // history fire identically either way. No gating beyond what a drag would
  // already allow: it just picks the next column for you. InvalidTransition/
  // ConcurrentTransition errors (e.g. a card in a state whose array-adjacent
  // "next" isn't actually a legal edge, or a concurrent mover) bubble to the
  // same global error handler the /transition route relies on, so they come
  // back as the same 409 either way.
  fastify.post("/cards/:id/advance", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const card = await advanceCardState({ cardId: id, actorType: "user" });
      reply.send(card);
    } catch (err) {
      if (err instanceof CardNotFoundError) {
        reply.status(404).send({ error: "not_found" });
        return;
      }
      if (err instanceof TerminalColumnError) {
        reply.status(409).send({ error: "terminal_column", message: err.message });
        return;
      }
      throw err;
    }
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

  // Human answers a card_questions escalation (spec: card-questions-escalation).
  // Auto-resumes the card blocked -> ready so it redispatches on the next
  // event-trigger tick, with the Q&A injected into the implementer's prompt.
  fastify.post("/cards/:id/questions/:questionId/answer", async (request, reply) => {
    const { id, questionId } = request.params as { id: string; questionId: string };
    const input = AnswerCardQuestionInputSchema.parse(request.body);

    const [question] = await fastify.db.select().from(cardQuestions).where(eq(cardQuestions.id, questionId));
    if (!question || question.cardId !== id) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    if (question.status === "answered") {
      reply.status(409).send({ error: "already_answered" });
      return;
    }

    const [updated] = await fastify.db
      .update(cardQuestions)
      .set({ status: "answered", answer: input.answer, answeredBy: input.answeredBy, answeredAt: new Date() })
      .where(eq(cardQuestions.id, questionId))
      .returning();

    const [card] = await fastify.db.select().from(cards).where(eq(cards.id, id));
    if (card?.state === "blocked") {
      await applyTransition({ cardId: id, toState: "ready", actorType: "user" });
    }

    reply.send(updated);
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
