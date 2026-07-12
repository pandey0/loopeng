import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cardDocLinks, cards, db, docs, pool } from "@loopeng/db";
import { createDoc } from "@loopeng/doc-engine";
import { getGate } from "@loopeng/gates";
import { afterAll, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { docRoutes } from "./docs.js";

// Real (non-mocked) end-to-end proof that the docs UI's "Accept" action --
// which calls POST /docs/:slug/versions with { status: "accepted" }, exactly
// as apps/web/lib/api.ts's acceptDoc() does -- is enough on its own to flip a
// proposed ADR to accepted and unblock the adr_required gate
// (packages/gates/src/checks/adr-required.ts). This is the other half of the
// gap the card describes: create_adr_doc (see create-adr-doc.test.ts in
// @loopeng/mcp-subagent) gets an ADR to status=proposed automatically; this
// test proves the human-facing accept step needs nothing beyond that same
// existing, already-public route -- no raw curl/psql required.
describe("POST /docs/:slug/versions accepts a proposed ADR (the docs UI Accept action's endpoint)", () => {
  let app: FastifyInstance;

  it("flips a proposed ADR to accepted and makes the adr_required gate pass", async () => {
    app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(docRoutes);

    const [board] = await db.insert(boards).values({ name: "docs-accept-e2e-verify (temporary)" }).returning();
    if (!board) throw new Error("failed to insert board");

    const [card] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "e2e: accept-ADR verification card", touchesArchitecture: true, state: "in_progress" })
      .returning();
    if (!card) throw new Error("failed to insert card");

    const slug = `accept-adr-e2e-verify-${randomUUID()}`;
    const content = "## Context\nThrowaway ADR for the accept-doc e2e test.\n\n## Decision\nThrowaway.";
    const doc = await createDoc(
      {
        slug,
        title: "e2e accept-ADR verify",
        docType: "adr",
        content,
        summary: "Throwaway ADR for the accept-doc e2e verification test.",
        tags: [],
        message: "create doc",
      },
      { status: "proposed" },
    );
    await db.insert(cardDocLinks).values({ cardId: card.id, docId: doc.id, linkType: "adr" });

    try {
      const gate = getGate("adr_required");
      if (!gate) throw new Error("adr_required gate must be registered");
      const ctx = { card } as Parameters<NonNullable<typeof gate>["run"]>[0];

      // Still proposed -- the gate must not pass yet.
      expect((await gate.run(ctx)).status).toBe("failed");

      const response = await app.inject({
        method: "POST",
        url: `/docs/${slug}/versions`,
        payload: { content, status: "accepted", message: "accept doc" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ status: "accepted" });

      const [updated] = await db.select().from(docs).where(eq(docs.id, doc.id));
      expect(updated?.status).toBe("accepted");

      // Same gate, same card, no other state touched -- now it passes.
      const outcome = await gate.run(ctx);
      expect(outcome.status).toBe("passed");
    } finally {
      await db.delete(docs).where(eq(docs.id, doc.id));
      await db.delete(boards).where(eq(boards.id, board.id));
      await app.close();
      await pool.end();
    }
  }, 30_000);
});
