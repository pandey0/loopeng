import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cardDocLinks, cards, db, docs, pool } from "@loopeng/db";
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

// A card without a linked spec doc always fails the docs_adr_linked gate
// eventually (packages/gates/src/checks/doc-linked.ts applies to every
// card unconditionally) -- these tests confirm that's now caught at
// creation time instead of after implementer/reviewer/gates already ran.
describe("POST /cards mandates a spec doc", () => {
  let app: FastifyInstance;
  let boardId: string;
  let specDocId: string;
  let authHeader: { Authorization: string };
  const createdCardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    authHeader = await authHeaderFor("user");

    const [board] = await db.insert(boards).values({ name: "card-create test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [doc] = await db
      .insert(docs)
      .values({ slug: "card-create-test-spec", title: "card-create test spec", docType: "wiki", repoPath: "wiki/card-create-test-spec.md" })
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

  it("rejects a create request with no specDocId at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards",
      headers: authHeader,
      payload: { boardId, title: "no spec doc field" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a specDocId that doesn't reference a real doc", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards",
      headers: authHeader,
      payload: { boardId, title: "fake spec doc", specDocId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "spec_doc_not_found" });
  });

  it("creates the card and the spec link together on a valid specDocId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/cards",
      headers: authHeader,
      payload: { boardId, title: "real spec doc", specDocId },
    });
    expect(response.statusCode).toBe(201);
    const card = response.json() as { id: string };
    createdCardIds.push(card.id);

    const links = await db.select().from(cardDocLinks).where(eq(cardDocLinks.cardId, card.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ docId: specDocId, linkType: "spec" });
  });
});
