import { eq } from "drizzle-orm";
import { cardDocLinks, cards, db, docs, pool } from "@loopeng/db";
import { getGate } from "@loopeng/gates";
import { afterAll, describe, expect, it } from "vitest";
import { ADR_SLUG, CARD_ID, ensureAdrLinked } from "./ensure-adr-linked.js";

// Real (non-mocked) end-to-end proof for card/multi-project-onboarding's
// "an ADR is written and linked before implementation ... adr_required gate
// must actually pass, not skip" criterion. A prior review rejected this card
// because "ADR written, accepted, and linked" is a runtime DB + wiki-repo-git
// action with zero footprint in a diff-only review — same problem class
// vault-and-metrics.real.test.ts already solved for the Obsidian-vault RFC
// card (see that file's header comment for the precedent). This test drives
// the real ensureAdrLinked() against the real, ambient WIKI_REPO_PATH /
// DATABASE_URL (deliberately not overridden to an isolated instance) and then
// runs the actual adrRequiredGate the orchestrator gate pipeline uses, so CI
// itself re-proves the deliverable — and the gate passing — on every run.
describe("real ADR link for card/multi-project-onboarding", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("creates/accepts/links the real ADR doc and leaves it in place", async () => {
    const { docId } = await ensureAdrLinked();

    const [doc] = await db.select().from(docs).where(eq(docs.id, docId));
    expect(doc, `expected ADR doc "${ADR_SLUG}" to exist in the real docs table`).toBeTruthy();
    expect(doc!.status).toBe("accepted");
    expect(doc!.docType).toBe("adr");

    const [link] = await db
      .select()
      .from(cardDocLinks)
      .where(eq(cardDocLinks.cardId, CARD_ID));
    expect(link, `expected a card_doc_links row for card ${CARD_ID}`).toBeTruthy();
    expect(link!.docId).toBe(docId);
    expect(link!.linkType).toBe("adr");
  }, 30_000);

  it("adr_required gate actually passes for this card (not skipped)", async () => {
    const [card] = await db.select().from(cards).where(eq(cards.id, CARD_ID));
    expect(card, `expected card ${CARD_ID} to exist`).toBeTruthy();
    expect(card!.touchesArchitecture, "this card must have touchesArchitecture=true for the gate to even apply").toBe(true);

    const gate = getGate("adr_required");
    expect(gate, "adr_required gate must be registered").toBeTruthy();

    const ctx = { card } as Parameters<NonNullable<typeof gate>["run"]>[0];
    expect(await gate!.appliesTo(ctx)).toBe(true);

    const outcome = await gate!.run(ctx);
    expect(outcome.status).toBe("passed");
  }, 30_000);
});
