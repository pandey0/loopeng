import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool } from "@loopeng/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

describe("POST /cards/:id/advance", () => {
  let app: FastifyInstance;
  let boardId: string;
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(cardRoutes);

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

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; state: string; updatedAt: string };
    expect(body.id).toBe(cardId);
    expect(body.state).toBe("in_progress");
    expect(body.updatedAt).toBeTruthy();

    const movedEvents = await db.select().from(eventLog).where(eq(eventLog.entityId, cardId));
    expect(movedEvents.some((e) => e.eventType === "card.moved")).toBe(true);
  });

  it("returns 409 (not a silent no-op) when the card is already in the terminal column", async () => {
    const cardId = await makeCard("advance route: done card", "done");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "terminal_column" });

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(card?.state).toBe("done");
  });

  it("returns 409 when the array-adjacent next column isn't a legal transition (blocked)", async () => {
    const cardId = await makeCard("advance route: blocked card", "blocked");

    const response = await app.inject({ method: "POST", url: `/cards/${cardId}/advance` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "invalid_transition" });
  });

  it("returns 404 for an unknown card id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards/00000000-0000-0000-0000-000000000000/advance",
    });
    expect(response.statusCode).toBe(404);
  });
});
