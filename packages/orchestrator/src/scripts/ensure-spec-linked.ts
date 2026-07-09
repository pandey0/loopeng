import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { cardDocLinks, db, pool } from "@loopeng/db";
import { createDoc, getDoc } from "@loopeng/doc-engine";

// Same diff-invisible-DB-action problem class as ensure-adr-linked.ts (see
// that file's header comment): the card's "Linked spec docs" section showed
// "(no linked spec docs found)" because a wiki-typed spec doc, spec-linked to
// this card, is itself a runtime DB + wiki-repo-git action with no footprint
// in a diff-only review. This script is the reusable, idempotent half of the
// fix, in the same shape planner intake uses for spec docs
// (persistDecomposition in packages/agents/src/decomposition.ts: docType
// "wiki", linkType "spec"): it creates (or reuses) the spec doc and links it
// to this card. Run via
// `pnpm --filter @loopeng/orchestrator exec tsx src/scripts/ensure-spec-linked.ts`.
export const CARD_ID = "c0681e77-31f9-4126-9f63-d96c040a95a5";
export const SPEC_SLUG = "spec-multi-project-onboarding";

const SPEC_CONTENT = `## Summary

The platform hardcodes one target repo (\`TARGET_REPO_PATH\`) and one board.
This card adds a \`projects\` table (repo path/URL, board FK, name), makes
\`worktree-manager\` and \`deploy-engine\` resolve the target repo per-project
instead of from a single env var, and adds a UI flow to register a new
project. See the linked ADR (\`adr/multi-project-onboarding\`) for the
architecture decision and rationale; this doc is the feature-level spec.

## Goals

- A \`projects\` table exists (repo path/URL, board FK, name); \`boards\` gains
  an optional \`project_id\` FK.
- \`worktree-manager\` and \`deploy-engine\` resolve \`TARGET_REPO_PATH\`
  per-project instead of a single hardcoded env var.
- A UI flow exists to register a new project (name + repo path/URL), and it
  appears as a selectable board on \`/board\`.
- Existing single-project behavior is unaffected when only one project is
  registered -- no forced migration UI for the current dogfood project.
- Registering a project whose repo path is not a git repository fails the
  registration UI immediately with a clear error.
- If a project's repo becomes invalid after registration, a card dispatched
  against it lands in \`blocked\` with a specific \`blockedReason\` instead of
  hanging silently in \`ready\`.

## Non-goals

- Cloning a remote repo URL into a local working copy. \`repoPath\` is
  accepted as a plain string at the schema level, but resolution still
  assumes a local checkout (matching how \`worktree-manager\`/\`deploy-engine\`
  already operate via \`simple-git\`) -- see the ADR's "Alternatives
  Considered" section.
- Any change to \`agents/roles.ts\`'s own \`resolveRepoRoot()\` call sites
  (planner/manager agents), which operate at the board/epic level before a
  project-scoped card exists.

## Rollout

Single-project deployments need zero action: a board with \`project_id = null\`
keeps resolving its repo the old way (env var, or \`git rev-parse
--show-toplevel\` fallback). Registering a second project is opt-in via the
new "New Project" UI flow, which creates the project and its board in one
request.

## Acceptance criteria

See the card's acceptance criteria for the authoritative list; summarized
above under Goals.
`;

// Idempotent — safe to call repeatedly (including from
// spec-linked.real.test.ts, which re-runs it against the real, ambient
// WIKI_REPO_PATH/DATABASE_URL on every CI run as diff-visible proof the spec
// doc actually exists and is linked to this card).
export async function ensureSpecLinked(): Promise<{ docId: string }> {
  const existing = await getDoc(SPEC_SLUG);
  const { id: docId } = existing
    ? existing
    : await createDoc({
        slug: SPEC_SLUG,
        title: "Spec: Multi-Project Onboarding",
        docType: "wiki",
        content: SPEC_CONTENT,
        summary:
          "Feature spec for the projects table + per-card repo resolution + project-registration UI (see the linked ADR for the architecture decision).",
        tags: ["spec", "multi-project", "worktree-manager", "deploy-engine"],
        message: "create spec: Multi-Project Onboarding",
      });

  const [existingLink] = await db
    .select()
    .from(cardDocLinks)
    .where(and(eq(cardDocLinks.cardId, CARD_ID), eq(cardDocLinks.docId, docId), eq(cardDocLinks.linkType, "spec")));
  if (!existingLink) {
    await db.insert(cardDocLinks).values({ cardId: CARD_ID, docId, linkType: "spec" }).onConflictDoNothing();
  }

  return { docId };
}

async function main() {
  const { docId } = await ensureSpecLinked();
  console.log(`Spec linked: doc ${docId} -> card ${CARD_ID} (linkType=spec)`);
  await pool.end();
}

// Only run as a CLI entrypoint, not when spec-linked.real.test.ts imports
// ensureSpecLinked() — same guard as ensure-adr-linked.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
}
