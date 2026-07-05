import { eq } from "drizzle-orm";
import { cards, db, eventLog, pool } from "@loopeng/db";
import { buildImplementerPrompt, distillFailureNote, type SpecDocContext } from "@loopeng/agents";
import { getDoc } from "@loopeng/doc-engine";

// One-off measurement for the doc-linked-card acceptance criterion on
// rfc/2026-07-obsidian-vault-token-efficiency: compares this card's actual
// implementer prompt (summary + slug per doc, lazy get_doc fetch) against the
// pre-this-card baseline (full doc body inlined per doc), using three real,
// substantial docs already in the vault as the linked set. Records the result
// as an event_log row on the card so it shows up in the card's activity feed.
// Run via `pnpm --filter @loopeng/orchestrator exec tsx src/scripts/measure-prompt-size.ts`.
const CARD_ID = "490369d1-261f-4054-860b-e538d76656c0";
const SAMPLE_DOC_SLUGS = [
  "adr/0001-use-drizzle-over-prisma",
  "adr/0002-interactive-multi-agent-sessions",
  "rfc/2026-07-agent-org-chart",
];

// What buildImplementerPrompt's spec-docs section looked like before this
// card (see git history of packages/agents/src/prompts.ts): full doc body
// inlined per linked doc, not a summary.
function oldStyleSpecDocsBlock(fullDocs: { title: string; body: string }[]): string {
  return fullDocs.length ? fullDocs.map((d) => `### Spec: ${d.title}\n${d.body}`).join("\n\n") : "(no linked spec docs found)";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // rough chars/4 heuristic, consistent for a relative before/after comparison
}

async function main() {
  const [card] = await db.select().from(cards).where(eq(cards.id, CARD_ID));
  if (!card) throw new Error(`card not found: ${CARD_ID}`);

  const fullDocs: { title: string; body: string }[] = [];
  const summaryDocs: SpecDocContext[] = [];
  for (const slug of SAMPLE_DOC_SLUGS) {
    const doc = await getDoc(slug);
    if (!doc) throw new Error(`sample doc not found — did the backfill script run? slug=${slug}`);
    fullDocs.push({ title: doc.title, body: doc.body });
    summaryDocs.push({ slug: doc.slug, title: doc.title, summary: doc.summary });
  }

  // Both prompts otherwise identical: same card, same (empty) skills/answered
  // questions — only the spec-docs section's format differs.
  const oldPrompt = buildImplementerPrompt(card, []).replace("(no linked spec docs found)", oldStyleSpecDocsBlock(fullDocs));
  const newPrompt = buildImplementerPrompt(card, [], undefined, summaryDocs);

  const oldChars = oldPrompt.length;
  const newChars = newPrompt.length;
  const oldTokens = estimateTokens(oldPrompt);
  const newTokens = estimateTokens(newPrompt);

  // Same before/after comparison for the retry failure-note path, using a
  // representative ~large reviewer rejection transcript.
  const sampleRejection = Array.from(
    { length: 60 },
    (_, i) => `Reviewer reasoning line ${i}: considered evidence in the diff around this acceptance criterion.`,
  ).join("\n");
  const oldFailureNote = `Reviewer rejected the previous attempt: ${sampleRejection.slice(0, 2000)}`;
  const newFailureNote = distillFailureNote("review_rejected", sampleRejection);

  const result = {
    sampleDocSlugs: SAMPLE_DOC_SLUGS,
    specDocsSection: {
      oldChars,
      newChars,
      oldEstTokens: oldTokens,
      newEstTokens: newTokens,
      reductionPct: Math.round((1 - newChars / oldChars) * 1000) / 10,
    },
    retryFailureNote: {
      oldChars: oldFailureNote.length,
      newChars: newFailureNote.length,
      oldLines: oldFailureNote.split("\n").length,
      newLines: newFailureNote.split("\n").length,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  await db.insert(eventLog).values({
    entityType: "card",
    entityId: CARD_ID,
    eventType: "card.doc_retrieval_benchmark",
    actorType: "agent",
    payload: result,
  });

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
