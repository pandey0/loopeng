import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardDocLinks, docs } from "@loopeng/db";
import { registerGate } from "../registry.js";
import type { GateCheck, GateContext, GateOutcome } from "../types.js";

export const adrRequiredGate: GateCheck = {
  key: "adr_required",
  name: "ADR linked if architecture touched",

  appliesTo(ctx: GateContext): boolean {
    return ctx.card.touchesArchitecture;
  },

  async run(ctx: GateContext): Promise<GateOutcome> {
    const rows = await db
      .select()
      .from(cardDocLinks)
      .innerJoin(docs, eq(cardDocLinks.docId, docs.id))
      .where(
        and(
          eq(cardDocLinks.cardId, ctx.card.id),
          eq(cardDocLinks.linkType, "adr"),
          eq(docs.status, "accepted"),
        ),
      );

    return rows.length > 0
      ? { status: "passed", detail: { adrDocIds: rows.map((r) => r.docs.id) } }
      : { status: "failed", detail: { reason: "architecture touched but no accepted ADR linked" } };
  },
};

registerGate(adrRequiredGate);
