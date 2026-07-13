import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { advanceCard, applyTransition, attachCardStatus, wouldCreateCycle } from "@loopeng/board-engine";
import { getSessionSnippet, sessionRegistry } from "@loopeng/agents";
import { getActiveWorktree, getRepoDiff } from "@loopeng/worktree-manager";
import {
  agentRoles,
  agentRuns,
  cardDependencies,
  cardDocLinks,
  cardQuestions,
  cards,
  db,
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

  // Human-only (card 438646e5): a new card has no existing owner to scope an
  // agent credential to, so it's board-shaping in the same sense boards/
  // projects/docs creation is -- this is also the exact route the
  // 2026-07-03 incident abused (an implementer minting an unrelated card to
  // "prove" an acceptance criterion). requireOwnCard can't help here since
  // there's no :id yet to check against the caller's run.
  fastify.post("/cards", { preHandler: fastify.requireHumanActor }, async (request, reply) => {
    const { specDocId, ...cardInput } = CardCreateInputSchema.parse(request.body);
    const actor = request.actor!;

    const [specDoc] = await fastify.db.select({ id: docs.id }).from(docs).where(eq(docs.id, specDocId));
    if (!specDoc) {
      reply.status(422).send({ error: "spec_doc_not_found", message: `no doc exists with id ${specDocId}` });
      return;
    }

    // Insert card + spec link + the card.created audit event together so a
    // card can never exist without the link that docs_adr_linked will
    // require of it anyway, or without a trace of who created it -- no
    // window where a half-created (or unaudited) card sits reachable if the
    // process dies partway through.
    const card = await fastify.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(cards).values(cardInput).returning();
      if (!inserted) throw new Error("card insert returned no row");
      await tx.insert(cardDocLinks).values({ cardId: inserted.id, docId: specDocId, linkType: "spec" });
      await tx.insert(eventLog).values({
        entityType: "card",
        entityId: inserted.id,
        eventType: "card.created",
        actorType: actor.type,
        actorId: actor.id,
        payload: { title: inserted.title, boardId: inserted.boardId },
      });
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

  fastify.patch("/cards/:id", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardUpdateInputSchema.parse(request.body);
    const actor = request.actor!;
    const [card] = await fastify.db
      .update(cards)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    if (!card) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    await fastify.db.insert(eventLog).values({
      entityType: "card",
      entityId: id,
      eventType: "card.updated",
      actorType: actor.type,
      actorId: actor.id,
      payload: { fields: Object.keys(input) },
    });
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

  fastify.post("/cards/:id/transition", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = CardTransitionInputSchema.parse(request.body);
    const actor = request.actor!;
    // actorType/actorId come from the verified caller, never from the
    // request body -- see card 438646e5 (any caller could previously
    // self-report actorType=user here, which is indistinguishable from a
    // real human action once it lands in event_log).
    const card = await applyTransition({ cardId: id, toState: input.toState, reason: input.reason, actorType: actor.type, actorId: actor.id ?? undefined });
    reply.send(card);
  });

  // Backs the card detail page's "move to next step" button. Resolves the
  // card's current state to its single forward edge server-side (see
  // NEXT_STATE in @loopeng/shared) rather than trusting the client with a
  // toState, through the same applyTransition path drag-and-drop uses -- so
  // orchestrator triggers and card.moved history fire identically either
  // way. CardNotFoundError/NoNextStateError/InvalidTransitionError/
  // ConcurrentTransitionError all bubble to the global error handler.
  fastify.post("/cards/:id/advance", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;
    const card = await advanceCard({ cardId: id, actorType: actor.type, actorId: actor.id ?? undefined });
    reply.send(card);
  });

  // Manual trigger for the Phase 2 autonomous loop — normally cron/event
  // triggers dispatch cards automatically, but this lets a human (or a
  // test) force a specific ready card through implementer -> reviewer ->
  // gate_checks without waiting for a schedule.
  fastify.post("/cards/:id/dispatch", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await fastify.orchestrator.coordination.dispatch(id);
    reply.status(202).send({ dispatched: id });
  });

  // Stops a card's live agent run right now and blocks the card, instead of
  // waiting for the current attempt to finish naturally -- e.g. a human
  // decides the foundation this run is building on needs fixing first (a
  // design-review finding on a dependency) and doesn't want it to keep
  // building on top of it. Blocks the card *before* closing the session, so
  // the recorded reason is this one, not whatever error text a killed
  // process happens to produce. Relies on the retry-loop guard in
  // orchestrator/loop.ts (re-checks card.state at the top of every retry
  // attempt) to make this stick -- without that guard, a still-in-flight
  // attempt's own retry logic would just spawn another implementer call
  // against a card that already moved off in_progress.
  fastify.post("/cards/:id/stop", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;
    const [card] = await db.select().from(cards).where(eq(cards.id, id));
    if (!card) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    if (card.state !== "in_progress") {
      reply.status(409).send({ error: "not_running", message: `card is "${card.state}", not in_progress` });
      return;
    }

    const input = request.body as { reason?: string } | undefined;
    const reason = input?.reason?.trim() || "stopped by user";
    await applyTransition({ cardId: id, toState: "blocked", actorType: actor.type, actorId: actor.id ?? undefined, reason });

    const [liveRun] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.cardId, id), eq(agentRuns.status, "running")))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    sessionRegistry.get(liveRun?.id ?? "")?.close();

    reply.send({ stopped: id, hadLiveSession: Boolean(liveRun) });
  });

  // Human answers a card_questions escalation (spec: card-questions-escalation).
  // Auto-resumes the card blocked -> ready so it redispatches on the next
  // event-trigger tick, with the Q&A injected into the implementer's prompt.
  fastify.post("/cards/:id/questions/:questionId/answer", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id, questionId } = request.params as { id: string; questionId: string };
    const actor = request.actor!;
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
      await applyTransition({ cardId: id, toState: "ready", actorType: actor.type, actorId: actor.id ?? undefined });
    }

    reply.send(updated);
  });

  fastify.post("/cards/:id/dependencies", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;
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
    await fastify.db.insert(eventLog).values({
      entityType: "card",
      entityId: id,
      eventType: "card.dependency_added",
      actorType: actor.type,
      actorId: actor.id,
      payload: { dependsOnCardId: input.dependsOnCardId, dependencyType: input.dependencyType },
    });
    reply.status(201).send(edge);
  });

  fastify.get("/cards/:id/dependencies", async (request) => {
    const { id } = request.params as { id: string };
    return fastify.db.select().from(cardDependencies).where(eq(cardDependencies.cardId, id));
  });

  fastify.post("/cards/:id/doc-links", { preHandler: [fastify.requireActor, fastify.requireOwnCard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.actor!;
    const input = CardDocLinkSchema.omit({ cardId: true }).parse(request.body);
    const [link] = await fastify.db
      .insert(cardDocLinks)
      .values({ cardId: id, docId: input.docId, linkType: input.linkType })
      .returning();
    await fastify.db.insert(eventLog).values({
      entityType: "card",
      entityId: id,
      eventType: "card.doc_link_added",
      actorType: actor.type,
      actorId: actor.id,
      payload: { docId: input.docId, linkType: input.linkType },
    });
    reply.status(201).send(link);
  });

  fastify.get("/cards/:id/doc-links", async (request) => {
    const { id } = request.params as { id: string };
    return fastify.db.select().from(cardDocLinks).where(eq(cardDocLinks.cardId, id));
  });
};
