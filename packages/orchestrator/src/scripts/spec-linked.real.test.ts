import { and, eq } from "drizzle-orm";
import { cardDocLinks, db, docs, pool } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { CARD_ID, ensureSpecLinked, SPEC_SLUG } from "./ensure-spec-linked.js";

// Real (non-mocked) end-to-end proof that card/multi-project-onboarding has
// a linked spec doc — same diff-invisible-DB-action problem class
// adr-linked.real.test.ts already solved for this card's ADR (see that
// file's header comment for the precedent). Drives the real
// ensureSpecLinked() against the real, ambient WIKI_REPO_PATH/DATABASE_URL
// (deliberately not overridden to an isolated instance), so CI itself
// re-proves the deliverable on every run instead of relying on an unprovable
// one-off hand-run state.
describe("real spec doc link for card/multi-project-onboarding", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates/links the real spec doc and leaves it in place", async () => {
    const { docId } = await ensureSpecLinked();

    const [doc] = await db.select().from(docs).where(eq(docs.id, docId));
    expect(doc, `expected spec doc "${SPEC_SLUG}" to exist in the real docs table`).toBeTruthy();
    expect(doc!.docType).toBe("wiki");
    expect(doc!.slug).toBe(SPEC_SLUG);

    const [link] = await db
      .select()
      .from(cardDocLinks)
      .where(and(eq(cardDocLinks.cardId, CARD_ID), eq(cardDocLinks.linkType, "spec")));
    expect(link, `expected a spec-linked card_doc_links row for card ${CARD_ID}`).toBeTruthy();
    expect(link!.docId).toBe(docId);
  }, 30_000);
});
