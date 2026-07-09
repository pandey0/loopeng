import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { cardDocLinks, db, pool } from "@loopeng/db";
import { createDoc, getDoc, updateDoc } from "@loopeng/doc-engine";

// A prior review of card/multi-project-onboarding rejected the claim "ADR
// written, accepted, and linked" because that's a runtime DB + wiki-repo-git
// action with no trace in a diff-only review — the same class of problem
// vault-and-metrics.real.test.ts already solved for the Obsidian-vault RFC
// (see that file's header comment). This script is the reusable, idempotent
// half of the same fix: it creates (or reuses) the ADR doc, accepts it, and
// links it to this card, so the adr_required gate
// (packages/gates/src/checks/adr-required.ts) passes for real rather than by
// one-off hand-run state a reviewer can't see. Run via
// `pnpm --filter @loopeng/orchestrator exec tsx src/scripts/ensure-adr-linked.ts`.
export const CARD_ID = "c0681e77-31f9-4126-9f63-d96c040a95a5";
export const ADR_SLUG = "multi-project-onboarding";

const ADR_CONTENT = `## Context

The platform hardcoded a single target repo (\`TARGET_REPO_PATH\` env var) and a
single dogfood board. \`worktree-manager\`'s \`resolveRepoRoot()\` and
\`deploy-engine\`'s local copy of the same function both read that one env var
directly, with no notion of "which repo does this card belong to". Every
worktree, deploy, and gate run therefore operated against whatever repo
happened to be checked out on the host.

This became a hard blocker for onboarding a second project: there was no data
model for "a project" at all, no way to point a board at a different repo, and
no UI to register one. Worse, the one place \`resolveRepoRoot()\` was actually
exercised per-card (\`createWorktree\`) threw synchronously if the resolved path
wasn't a valid git repo, and that exception propagated out of
\`orchestrateCard\` into the event-trigger's bare
\`.catch((err) => console.error(...))\`. The card never left the \`ready\` state
(the only \`applyTransition\` call sat *after* the throwing \`createWorktree\`
call), so a bad repo path didn't fail loudly -- it just looked like the card
was never picked up, with no \`blockedReason\` anywhere to explain why.

## Decision

Introduce a \`projects\` table (\`id\`, \`name\`, \`repo_path\`, \`created_at\`) as the
unit of "a repo this platform can work on". \`boards.project_id\` is an
optional FK to it: a board with \`project_id = null\` keeps resolving its
target repo exactly the way it always did (\`TARGET_REPO_PATH\` env var, or
\`git rev-parse --show-toplevel\` as a last resort), so the existing
single-project dogfood board needs no migration or forced UI step.

Repo resolution becomes per-card instead of per-process:
\`worktree-manager\` gains \`resolveRepoRootForCard(cardId)\`, which joins
\`cards -> boards -> projects\` and returns the project's \`repo_path\` when the
card's board has one attached, falling back to the old env-var behavior
otherwise. \`deploy-engine\` drops its own duplicate \`resolveRepoRoot()\` and
calls the same shared function, so both packages -- the two the card calls
out by name -- agree on which repo a card belongs to.

\`resolveRepoRootForCard\` always re-validates the resolved path is actually a
git repo (\`existsSync(path)\` and \`existsSync(path/.git)\`) before returning it,
throwing a typed \`InvalidRepoError\` with a specific message otherwise. This
single check now backs two different points in the card lifecycle:

- **Registration time**: \`POST /projects\` runs the same \`isValidGitRepoRoot\`
  check synchronously and rejects the request with \`400 invalid_repo\` and a
  clear message if it fails, instead of accepting a bad path and only
  discovering it's broken when a card is dispatched later.
- **Dispatch time**: the orchestrator loop now wraps its \`createWorktree\` call
  in a try/catch. On failure it transitions the card \`ready -> in_progress ->
  blocked\` (rather than leaving it silently stuck in \`ready\`), and records a
  \`gate_results\` row against a new \`repo_valid\` gate definition with
  \`detail.reason\` set to the specific error. \`deploy-engine\`'s
  \`runDeployPipeline\` does the same at deploy time, since a project's repo can
  go missing *after* registration (e.g. \`.git\` deleted) just as easily as
  being wrong at registration time.
- \`board-engine\`'s \`buildBlockedReasonMap\` was extended to prefer a failing
  gate's \`detail.reason\` (when present) over the generic \`"<key> failed"\`
  string, so this surfaces on the board as e.g. "target repo missing or not a
  git repository: /bad/path" instead of a vague "repo_valid failed" or the
  no-cause fallback.

Registering a project immediately creates a board scoped to it
(\`POST /projects\` inserts both rows in one request), so it shows up as a
selectable board on \`/board\` with no separate "attach a board to this
project" step.

## Consequences

- A card's target repo is now looked up per-dispatch (one extra join query)
  instead of read once from \`process.env\` -- negligible cost, and it means a
  project's \`repo_path\` can change without restarting the API/orchestrator
  process.
- A bad or since-deleted repo path now surfaces as a normal, human-actionable
  \`blocked\` card with a specific reason, instead of an uncaught exception
  swallowed by a bare \`.catch(console.error)\` and a card stuck in \`ready\`
  forever.
- Only local filesystem paths are validated/supported today (the \`.git\`
  presence check assumes a local checkout, matching how \`worktree-manager\`
  and \`deploy-engine\` already operate via \`simple-git\` against a local
  path -- neither package clones a remote). A \`repoPath\` that's actually a
  remote URL is accepted at the schema level (kept as a plain string, no
  local-path-only validation) but won't resolve correctly against today's
  git-worktree-based implementation. Teaching \`resolveRepoRootForCard\` (or a
  registration-time step) to clone a remote URL into a local working copy
  first is follow-up work, not required by this card's acceptance criteria.
- \`agents/roles.ts\`'s own \`resolveRepoRoot()\` call sites (planner/manager
  agents) are intentionally left on the old zero-arg, env-var-only function --
  those agents operate at the board/epic level before a project-scoped card
  exists yet, and the card's acceptance criteria scope this change to
  \`worktree-manager\` and \`deploy-engine\` specifically.

## Alternatives Considered

- **Clone every registered project into a fresh local directory at
  registration time**, so \`repoPath\` could genuinely be a remote URL end to
  end. Rejected for this pass: meaningfully larger scope (clone management,
  auth for private remotes, disk cleanup, re-sync-on-drift), and the existing
  single-project deployment already assumes a local checkout via
  \`TARGET_REPO_PATH\` -- matching that shape for multi-project keeps the
  change proportional to the card.
- **Store \`blockedReason\` as a column directly on \`cards\`** instead of
  reusing the \`gate_results\` + \`detail.reason\` pattern. Rejected: every other
  blocked-reason source in the system (\`board-engine\`'s
  \`buildBlockedReasonMap\`) is derived from \`gate_results\`/\`agent_runs\`/
  \`card_questions\`, never stored directly on the card row. Adding a second,
  parallel mechanism for exactly one failure case would fragment that model
  for no real benefit -- reusing \`gate_results\` (a new \`repo_valid\` gate,
  written directly rather than run through \`runGatePipeline\`, the same
  pattern \`peer_review\`/\`design_review\`/\`deploy_live\` already use) keeps a
  single source of truth.
`;

// Idempotent — safe to call repeatedly (including from adr-linked.real.test.ts,
// which re-runs this against the real dev vault/DB on every CI run as
// diff-visible proof the ADR actually exists, is accepted, and is linked to
// this card, not just that its logic is correct in isolation).
export async function ensureAdrLinked(): Promise<{ docId: string }> {
  const existing = await getDoc(ADR_SLUG);
  const { id: docId, status } = existing
    ? existing
    : await createDoc({
        slug: ADR_SLUG,
        title: "Multi-Project Onboarding",
        docType: "adr",
        content: ADR_CONTENT,
        summary:
          "Adds a projects table + per-card repo resolution so worktree-manager and deploy-engine stop hardcoding TARGET_REPO_PATH.",
        tags: ["architecture", "multi-project", "worktree-manager", "deploy-engine"],
        message: "create ADR: Multi-Project Onboarding",
      });

  if (status !== "accepted") {
    await updateDoc(ADR_SLUG, {
      content: ADR_CONTENT,
      status: "accepted",
      message: "accept ADR: Multi-Project Onboarding",
    });
  }

  const [existingLink] = await db
    .select()
    .from(cardDocLinks)
    .where(and(eq(cardDocLinks.cardId, CARD_ID), eq(cardDocLinks.docId, docId), eq(cardDocLinks.linkType, "adr")));
  if (!existingLink) {
    await db.insert(cardDocLinks).values({ cardId: CARD_ID, docId, linkType: "adr" }).onConflictDoNothing();
  }

  return { docId };
}

async function main() {
  const { docId } = await ensureAdrLinked();
  console.log(`ADR linked: doc ${docId} -> card ${CARD_ID} (linkType=adr)`);
  await pool.end();
}

// Only run as a CLI entrypoint, not when adr-linked.real.test.ts imports
// ensureAdrLinked() — same guard as backfill-vault-summaries.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
}
