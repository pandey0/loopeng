import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardDocLinks, cards, docs, skills } from "@loopeng/db";
import type { DocType } from "@loopeng/shared";

export interface StaleDocCandidateRow {
  docId: string;
  slug: string;
  title: string;
  docType: DocType;
  docUpdatedAt: Date;
  cardId: string;
  cardTitle: string;
  cardUpdatedAt: Date;
  skillLastVerifiedAt: Date | null;
}

export interface StaleDoc {
  docId: string;
  slug: string;
  title: string;
  docType: DocType;
  cardId: string;
  cardTitle: string;
  docLastVerifiedAt: Date;
  cardUpdatedAt: Date;
}

// A doc is stale when the code it documents (its linked card) shipped
// ("done") after the doc was last touched. Skill docs track their own
// verification timestamp (skills.last_verified_at) instead of the doc's
// commit time, since a skill can be re-verified without a new commit.
export function computeStaleDocs(rows: StaleDocCandidateRow[]): StaleDoc[] {
  const stale: StaleDoc[] = [];
  for (const row of rows) {
    const docLastVerifiedAt = row.skillLastVerifiedAt ?? row.docUpdatedAt;
    if (row.cardUpdatedAt > docLastVerifiedAt) {
      stale.push({
        docId: row.docId,
        slug: row.slug,
        title: row.title,
        docType: row.docType,
        cardId: row.cardId,
        cardTitle: row.cardTitle,
        docLastVerifiedAt,
        cardUpdatedAt: row.cardUpdatedAt,
      });
    }
  }
  return stale;
}

async function fetchCandidateRows(): Promise<StaleDocCandidateRow[]> {
  const rows = await db
    .select({
      docId: docs.id,
      slug: docs.slug,
      title: docs.title,
      docType: docs.docType,
      docUpdatedAt: docs.updatedAt,
      cardId: cards.id,
      cardTitle: cards.title,
      cardUpdatedAt: cards.updatedAt,
      skillLastVerifiedAt: skills.lastVerifiedAt,
    })
    .from(docs)
    .innerJoin(cardDocLinks, eq(cardDocLinks.docId, docs.id))
    .innerJoin(cards, eq(cards.id, cardDocLinks.cardId))
    .leftJoin(skills, eq(skills.docId, docs.id))
    .where(and(eq(cards.state, "done"), notInArray(docs.status, ["superseded", "deprecated"])));

  return rows.map((row) => ({ ...row, docType: row.docType as DocType }));
}

export async function findStaleDocs(): Promise<StaleDoc[]> {
  const rows = await fetchCandidateRows();
  return computeStaleDocs(rows);
}
