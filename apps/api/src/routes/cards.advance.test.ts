import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool } from "@loopeng/db";
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

describe("POST /cards/:id/advance", () => {
  let app: FastifyInstance;
  let boardId: string;
  let authHeader: { Authorization: string };
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    authHeader = await authHeaderFor("user");

    const [board] = await db.insert(boards).values({ name: "card-advance test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;
  });

  afterEach(async () => {
    for (const id of createdCardIds.splice(0)) {
      await db.delete(cards).where(eq(cards.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  async function makeCard(title: string, state: string) {
    const [card] = await db.insert(cards).values({ boardId, title, state }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    createdCardIds.push(card.id);
    return card.id;
  }

  it("moves the card to the next column and returns the updated card with its new status and updatedAt", async () => {
    const cardId = await makeCard("advance route: ready card", "ready");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance`, headers: authHeader });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; state: string; updatedAt: string };
    expect(body.id).toBe(cardId);
    expect(body.state).toBe("in_progress");
    expect(body.updatedAt).toBeTruthy();

    const movedEvents = await db.select().from(eventLog).where(eq(eventLog.entityId, cardId));
    expect(movedEvents.some((e) => e.eventType === "card.moved")).toBe(true);
  });

  it("routes in_review through gate_checks, matching the Phase 3 gate pipeline rather than skipping straight to done", async () => {
    const cardId = await makeCard("advance route: in_review card", "in_review");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance`, headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "gate_checks" });
  });

  it("returns 409 (not a silent no-op) when the card is already in a terminal state", async () => {
    const cardId = await makeCard("advance route: done card", "done");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance`, headers: authHeader });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "no_next_state" });

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(card?.state).toBe("done");
  });

  // Regression: advanceCard used to resolve the forward edge by walking a
  // fixed column-order list, which sent blocked -> done (not a legal
  // TRANSITIONS edge, so this returned 409 invalid_transition). It now
  // resolves through NEXT_STATE (@loopeng/shared), which routes blocked to
  // ready, so this succeeds.
  it("resolves blocked's forward edge to ready, not the array-adjacent (and illegal) done", async () => {
    const cardId = await makeCard("advance route: blocked card", "blocked");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance`, headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "ready" });
  });

  it("returns 404 for an unknown card id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards/00000000-0000-0000-0000-000000000000/advance",
      headers: authHeader,
    });
    expect(response.statusCode).toBe(404);
  });
});
