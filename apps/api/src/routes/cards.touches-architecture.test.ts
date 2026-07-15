import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cards, db, docs, pool } from "@loopeng/db";
import { getGate } from "@loopeng/gates";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Regression test for the bug where touchesArchitecture was missing from
// CardCreateInputSchema/CardUpdateInputSchema, so zod silently stripped it
// from both POST /cards and PATCH /cards/:id -- leaving raw DB access as the
// only way to set or correct the flag the adr_required gate keys off of.
describe("touchesArchitecture is settable and correctable via the API", () => {
  let app: FastifyInstance;
  let boardId: string;
  let specDocId: string;
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(cardRoutes);

    const [board] = await db
      .insert(boards)
      .values({ name: "touches-architecture test board" })
      .returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [doc] = await db
      .insert(docs)
      .values({
        slug: "touches-architecture-test-spec",
        title: "touches-architecture test spec",
        docType: "wiki",
        repoPath: "wiki/touches-architecture-test-spec.md",
      })
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

  it("accepts touchesArchitecture=true at creation and flips the adr_required gate on", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { boardId, title: "architecture-touching card", specDocId, touchesArchitecture: true },
    });
    expect(response.statusCode).toBe(201);
    const card = response.json() as { id: string; touchesArchitecture: boolean };
    createdCardIds.push(card.id);
    expect(card.touchesArchitecture).toBe(true);

    const gate = getGate("adr_required");
    if (!gate) throw new Error("adr_required gate must be registered");
    expect(gate.appliesTo({ card } as Parameters<NonNullable<typeof gate>["appliesTo"]>[0])).toBe(true);
  });

  it("defaults touchesArchitecture to false when omitted at creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { boardId, title: "non-architecture card", specDocId },
    });
    expect(response.statusCode).toBe(201);
    const card = response.json() as { id: string; touchesArchitecture: boolean };
    createdCardIds.push(card.id);
    expect(card.touchesArchitecture).toBe(false);
  });

  it("corrects a wrong touchesArchitecture value via PATCH /cards/:id, flipping the gate on", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { boardId, title: "wrongly-flagged card", specDocId },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as { id: string; touchesArchitecture: boolean };
    createdCardIds.push(created.id);
    expect(created.touchesArchitecture).toBe(false);

    const gate = getGate("adr_required");
    if (!gate) throw new Error("adr_required gate must be registered");
    expect(gate.appliesTo({ card: created } as Parameters<NonNullable<typeof gate>["appliesTo"]>[0])).toBe(false);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/cards/${created.id}`,
      payload: { touchesArchitecture: true },
    });
    expect(patchResponse.statusCode).toBe(200);
    const patched = patchResponse.json() as { id: string; touchesArchitecture: boolean };
    expect(patched.touchesArchitecture).toBe(true);

    const [row] = await db.select().from(cards).where(eq(cards.id, created.id));
    expect(row?.touchesArchitecture).toBe(true);
    expect(gate.appliesTo({ card: row } as Parameters<NonNullable<typeof gate>["appliesTo"]>[0])).toBe(true);
  });
});
