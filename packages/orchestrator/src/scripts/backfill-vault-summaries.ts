import { pathToFileURL } from "node:url";
import { pool } from "@loopeng/db";
import { getDoc, updateDoc } from "@loopeng/doc-engine";

// One-time backfill, run once against the real dev data/wiki-repo (not a
// *.test.ts — it mutates the actual vault/DB, same as seed.ts). Existing docs
// predate the mandatory-summary convention (RFC: rfc/2026-07-obsidian-vault-
// token-efficiency), so updateDoc would otherwise reject their next edit with
// no summary to fall back to. This also wires real [[wikilinks]] between the
// vault's existing RFC/ADR docs so data/wiki-repo has at least one connected
// graph to show when opened in Obsidian (acceptance criterion for that RFC's
// card). Run via `pnpm --filter @loopeng/orchestrator exec tsx src/scripts/backfill-vault-summaries.ts`.
export interface Backfill {
  slug: string;
  summary: string;
  /** Appended verbatim to the doc's existing body. */
  relatedSection: string;
}

export const BACKFILLS: Backfill[] = [
  {
    slug: "adr/0001-use-drizzle-over-prisma",
    summary: "Chose Drizzle over Prisma to keep the doc-engine/board-engine schema close to plain, inspectable SQL.",
    relatedSection: "\n\n## Related\n- [[adr/0002-interactive-multi-agent-sessions]] — the next architecture ADR, built on top of this data layer.\n",
  },
  {
    slug: "adr/0002-interactive-multi-agent-sessions",
    summary: "Moved agent runs to long-lived streaming sessions with a custom MCP-based spawn_sub_agent delegation mechanism.",
    relatedSection:
      "\n\n## Related\n- [[adr/0001-use-drizzle-over-prisma]] — the data layer this session/sub-agent tracking is built on.\n" +
      "- [[rfc/2026-07-agent-org-chart]] — extends this ADR's spawn_sub_agent contract with a needsApproval escalation field.\n" +
      "- [[rfc/2026-07-obsidian-vault-token-efficiency]] — delivers get_doc on the same MCP server this ADR introduced.\n",
  },
  {
    slug: "rfc/2026-07-agent-org-chart",
    summary: "Evolves the flat implementer/reviewer/planner roles into a Manager/Tech-Lead/Worker reporting hierarchy.",
    relatedSection:
      "\n\n## Related\n- [[adr/0002-interactive-multi-agent-sessions]] — the streaming/sub-agent transport this hierarchy runs on top of.\n" +
      "- [[rfc/2026-07-obsidian-vault-token-efficiency]] — the lazy-doc-retrieval model every role's prompt (including new Manager/Tech-Lead ones) should use.\n",
  },
  {
    slug: "rfc/2026-07-obsidian-vault-token-efficiency",
    summary: "Switches agent prompts to one-line doc summaries + lazy get_doc(slug) fetch, and makes data/wiki-repo a real Obsidian vault.",
    relatedSection: "\n\n## Related\n- [[adr/0002-interactive-multi-agent-sessions]] — the MCP server get_doc is added to.\n",
  },
];

// Idempotent — safe to call repeatedly (including from vault-and-metrics.real.test.ts,
// which re-runs this against the real dev vault on every CI run as diff-visible
// proof the backfill actually executes, not just that its logic is correct in
// isolation). Exported (not folded into main()) so that test can drive the
// exact same code path the CLI script does.
export async function runBackfill(): Promise<void> {
  for (const { slug, summary, relatedSection } of BACKFILLS) {
    const existing = await getDoc(slug);
    if (!existing) {
      console.warn(`[backfill] skipping missing doc: ${slug}`);
      continue;
    }
    if (existing.body.includes("## Related")) {
      console.log(`[backfill] ${slug} already has a Related section, skipping body append (summary still applied)`);
    }
    const content = existing.body.includes("## Related") ? existing.body : `${existing.body}${relatedSection}`;
    await updateDoc(slug, {
      content,
      summary,
      message: "backfill: add mandatory summary + Obsidian wikilinks (rfc/2026-07-obsidian-vault-token-efficiency)",
    });
    console.log(`[backfill] updated ${slug}`);
  }
}

async function main() {
  await runBackfill();
  await pool.end();
}

// Only run as a CLI entrypoint, not when vault-and-metrics.real.test.ts imports
// runBackfill() — otherwise every test run would also trigger this pool.end()/
// process.exit and tear down the test's own DB connection out from under it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
}
