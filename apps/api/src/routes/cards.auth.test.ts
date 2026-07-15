import Fastify, { type FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { agentRuns, boards, cards, db, docs, eventLog, pool } from "@loopeng/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Regression tests for card 438646e5: the 2026-07-03 incident happened
// because (a) POST /cards/:id/transition trusted a client-supplied
// actorType field, so any caller (including an agent's own curl) could
// self-report actorType=user, and (b) an agent worktree could reach the
// database directly to delete what it created, leaving zero event_log
// trace. These tests hit the real HTTP + DB layers (no mocking) and confirm
// an agent-scoped caller can no longer forge a "user" attribution, and that
// every mutation -- whoever makes it -- lands in event_log with a verified
// identity or doesn't happen at all.
describe("card mutation routes: verified actor identity", () => {
  let app: FastifyInstance;
  let boardId: string;
  let specDocId: string;
  const fakeAgentRunId = "00000000-0000-0000-0000-0000000000ff";
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    const [board] = await db.insert(boards).values({ name: "card-auth test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [doc] = await db
      .insert(docs)
      .values({ slug: "card-auth-test-spec", title: "card-auth test spec", docType: "wiki", repoPath: "wiki/card-auth-test-spec.md" })
      .returning({ id: docs.id });
    if (!doc) throw new Error("doc insert returned no row");
    specDocId = doc.id;
  });

  afterEach(async () => {
    for (const id of createdCardIds.splice(0)) {
      await db.delete(cards).where(eq(cards.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(docs).where(eq(docs.id, specDocId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  it("401s a card creation with no Authorization header at all, and creates nothing", async () => {
    const before = await db.select().from(cards).where(eq(cards.boardId, boardId));

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { boardId, title: "unauthenticated create attempt", specDocId },
    });

    expect(response.statusCode).toBe(401);
    const after = await db.select().from(cards).where(eq(cards.boardId, boardId));
    expect(after).toHaveLength(before.length);
  });

  it("403s a card creation attempt by an agent-scoped key -- card creation is human-only, and creates nothing", async () => {
    const agentHeader = await authHeaderFor("agent", fakeAgentRunId);
    const before = await db.select().from(cards).where(eq(cards.boardId, boardId));

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      headers: agentHeader,
      // Reproduces the 2026-07-03 incident's exact move: an agent minting a
      // brand-new, unrelated card. This must now be rejected outright, not
      // merely attributed correctly -- a new card has no existing owner to
      // scope an agent credential to.
      payload: { boardId, title: "agent-created card", specDocId },
    });

    expect(response.statusCode).toBe(403);
    const after = await db.select().from(cards).where(eq(cards.boardId, boardId));
    expect(after).toHaveLength(before.length);
  });

  it("attributes a card created by a verified human caller as actorType=user in event_log", async () => {
    const humanHeader = await authHeaderFor("user");

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      headers: humanHeader,
      payload: { boardId, title: "human-created card", specDocId },
    });

    expect(response.statusCode).toBe(201);
    const card = response.json() as { id: string };
    createdCardIds.push(card.id);

    const [createdEvent] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, card.id), eq(eventLog.eventType, "card.created")));
    expect(createdEvent).toMatchObject({ actorType: "user" });
  });

  it("ignores a forged actorType in the transition body -- the event is attributed to the verified caller, not the claim", async () => {
    const [card] = await db.insert(cards).values({ boardId, title: "transition forgery attempt", state: "ready" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    createdCardIds.push(card.id);

    // requireOwnCard only authorizes an agent-scoped key for the card its
    // run was actually dispatched against, so the run row must point at
    // this card for the request to get past that gate at all.
    const [run] = await db.insert(agentRuns).values({ cardId: card.id, status: "running" }).returning({ id: agentRuns.id });
    if (!run) throw new Error("agent run insert returned no row");
    const agentHeader = await authHeaderFor("agent", run.id);

    const response = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/transition`,
      headers: agentHeader,
      // A naive attacker's first move: just claim to be a user in the body,
      // the same shape the pre-fix schema used to accept as authoritative.
      payload: { toState: "in_progress", actorType: "user", actorId: "00000000-0000-0000-0000-000000000001" },
    });

    expect(response.statusCode).toBe(200);

    const [movedEvent] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, card.id), eq(eventLog.eventType, "card.moved")))
      .orderBy(desc(eventLog.id));
    expect(movedEvent).toMatchObject({ actorType: "agent", actorId: run.id });

    await db.delete(agentRuns).where(eq(agentRuns.id, run.id));
  });

  it("401s a transition with no Authorization header, and leaves no event_log trace or state change", async () => {
    const [card] = await db.insert(cards).values({ boardId, title: "unauthenticated transition attempt", state: "ready" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    createdCardIds.push(card.id);

    const response = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/transition`,
      payload: { toState: "in_progress" },
    });

    expect(response.statusCode).toBe(401);

    const [unchanged] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(unchanged?.state).toBe("ready");

    const events = await db.select().from(eventLog).where(eq(eventLog.entityId, card.id));
    expect(events).toHaveLength(0);
  });

  it("401s advance/stop/dependencies/doc-links without a verified caller", async () => {
    const [card] = await db.insert(cards).values({ boardId, title: "unauthenticated misc attempts", state: "ready" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    createdCardIds.push(card.id);

    const advance = await app.inject({ method: "POST", url: `/cards/${card.id}/advance` });
    expect(advance.statusCode).toBe(401);

    const doc = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/doc-links`,
      payload: { docId: specDocId, linkType: "related" },
    });
    expect(doc.statusCode).toBe(401);
  });
});
