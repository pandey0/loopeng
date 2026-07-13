import Fastify, { type FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { agentRuns, boards, cards, db, eventLog, pool } from "@loopeng/db";
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

// Regression test for card 438646e5's core acceptance criterion: an agent
// worktree's credential is scoped to the one card it was dispatched for
// (cardScopedAgentEnv in @loopeng/agents mints it that way), so it can no
// longer create/mutate/delete board data outside that card -- and any
// attempt to do so is itself audited (card.access_denied), not silent, which
// is exactly the gap the 2026-07-03 incident's raw-DB delete exploited.
describe("requireOwnCard: agent-scoped credentials can't touch other cards", () => {
  let app: FastifyInstance;
  let boardId: string;
  let ownCardId: string;
  let otherCardId: string;
  let ownRunId: string;
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    const [board] = await db.insert(boards).values({ name: "own-card test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [own] = await db.insert(cards).values({ boardId, title: "agent's own card", state: "ready" }).returning({ id: cards.id });
    const [other] = await db.insert(cards).values({ boardId, title: "an unrelated card", state: "ready" }).returning({ id: cards.id });
    if (!own || !other) throw new Error("card insert returned no row");
    ownCardId = own.id;
    otherCardId = other.id;
    createdCardIds.push(ownCardId, otherCardId);

    const [run] = await db.insert(agentRuns).values({ cardId: ownCardId, status: "running" }).returning({ id: agentRuns.id });
    if (!run) throw new Error("agent run insert returned no row");
    ownRunId = run.id;
  });

  afterEach(async () => {
    await db.delete(eventLog).where(eq(eventLog.eventType, "card.access_denied"));
  });

  afterAll(async () => {
    await db.delete(agentRuns).where(eq(agentRuns.id, ownRunId));
    for (const id of createdCardIds) await db.delete(cards).where(eq(cards.id, id));
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  it("403s an agent-scoped caller transitioning a card that isn't its own, and audits the attempt", async () => {
    const agentHeader = await authHeaderFor("agent", ownRunId);

    const response = await app.inject({
      method: "POST",
      url: `/cards/${otherCardId}/transition`,
      headers: agentHeader,
      payload: { toState: "in_progress" },
    });

    expect(response.statusCode).toBe(403);

    const [unchanged] = await db.select().from(cards).where(eq(cards.id, otherCardId));
    expect(unchanged?.state).toBe("ready");

    const [denied] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, otherCardId), eq(eventLog.eventType, "card.access_denied")));
    expect(denied).toMatchObject({ actorType: "agent", actorId: ownRunId });
    expect(denied?.payload).toMatchObject({ attemptedMethod: "POST", ownCardId });
  });

  it("403s an agent-scoped caller stopping/advancing a card that isn't its own", async () => {
    const agentHeader = await authHeaderFor("agent", ownRunId);

    const stop = await app.inject({ method: "POST", url: `/cards/${otherCardId}/stop`, headers: agentHeader });
    expect(stop.statusCode).toBe(403);

    const advance = await app.inject({ method: "POST", url: `/cards/${otherCardId}/advance`, headers: agentHeader });
    expect(advance.statusCode).toBe(403);

    const events = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, otherCardId), eq(eventLog.eventType, "card.access_denied")));
    expect(events).toHaveLength(2);
  });

  it("still allows the same agent-scoped caller to act on its own card", async () => {
    const agentHeader = await authHeaderFor("agent", ownRunId);

    const response = await app.inject({
      method: "POST",
      url: `/cards/${ownCardId}/transition`,
      headers: agentHeader,
      payload: { toState: "in_progress" },
    });

    expect(response.statusCode).toBe(200);

    const [moved] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, ownCardId), eq(eventLog.eventType, "card.moved")));
    expect(moved).toMatchObject({ actorType: "agent", actorId: ownRunId });
  });

  it("does not scope a human (user) caller to any single card", async () => {
    const humanHeader = await authHeaderFor("user");

    const response = await app.inject({
      method: "POST",
      url: `/cards/${otherCardId}/stop`,
      headers: humanHeader,
    });

    // Not 403'd by requireOwnCard (a human isn't card-scoped); whatever
    // status comes back is from the route's own logic, not the authz gate.
    expect(response.statusCode).not.toBe(403);
  });
});
