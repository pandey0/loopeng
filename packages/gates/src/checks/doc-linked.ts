import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardDocLinks } from "@loopeng/db";
import { registerGate } from "../registry.js";
import type { GateCheck, GateContext, GateOutcome } from "../types.js";

export const docLinkedGate: GateCheck = {
  key: "docs_adr_linked",
  name: "Spec doc linked",

  appliesTo(): boolean {
    return true;
  },

  async run(ctx: GateContext): Promise<GateOutcome> {
    const links = await db
      .select()
      .from(cardDocLinks)
      .where(and(eq(cardDocLinks.cardId, ctx.card.id), eq(cardDocLinks.linkType, "spec")));

    return links.length > 0
      ? { status: "passed", detail: { specDocIds: links.map((l) => l.docId) } }
      : { status: "failed", detail: { reason: "no doc linked with link_type=spec" } };
  },
};

registerGate(docLinkedGate);
