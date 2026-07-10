import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { applyTransition, attachCardStatus, wouldCreateCycle } from "@loopeng/board-engine";
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
