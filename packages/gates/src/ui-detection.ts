import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardDocLinks, docs as docsTable } from "@loopeng/db";
import { getDoc } from "@loopeng/doc-engine";
import { cardTagsIndicateUi, textMentionsUiPaths } from "@loopeng/shared";
import type { GateContext } from "./types.js";

// Whether a card qualifies for the designer role: tagged ui/ux, or (fallback,
// since tags are set manually) a linked spec doc mentions a UI-owning path.
// This is the design_review gate's appliesTo() predicate, but it is also
// called directly by the orchestrator loop to decide whether to run the
// designer spec/review agents at all — design_review's gate_results row is
// written by the orchestrator from that review's verdict, the same way
// peer_review's is, so there is no registered GateCheck to run it through
// the pipeline.
export async function cardTouchesUi(card: GateContext["card"]): Promise<boolean> {
  if (cardTagsIndicateUi(card.tags)) return true;

  const linkedSpecs = await db
    .select()
    .from(cardDocLinks)
    .innerJoin(docsTable, eq(cardDocLinks.docId, docsTable.id))
    .where(and(eq(cardDocLinks.cardId, card.id), eq(cardDocLinks.linkType, "spec")));

  for (const row of linkedSpecs) {
    const full = await getDoc(row.docs.slug);
    if (full && textMentionsUiPaths(full.body)) return true;
  }
  return false;
}
