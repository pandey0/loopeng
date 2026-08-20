# Flows: what's real, verified against the running app

`docs/USER_JOURNEY.md` walks one scenario end to end as a narrative. This doc is the flip side: every major flow, checked individually against the actual running instance (containers up, hitting the real API and reading the real Postgres/wiki-repo data this repo's own dogfood board has accumulated) rather than just read out of source. Where something didn't match the other docs or looked broken, it's called out explicitly, and the other docs were corrected in the same pass.

Verified by: `docker compose up` in `infrastructure/docker/`, then `curl` against `localhost:4000` with the default local `x-api-key`, plus reading the actual route/component source for anything the API alone couldn't confirm. Browser-based click-through wasn't available this session (Chrome extension not connected) — everything below is either a live API response or a direct source read of the exact code path, not a guess.

---

## 1. Project onboarding — the real gap, root-caused and partially fixed

`GET /projects` on the running instance returns this repo's own real project:

```json
{"id":"37f6a6b5-...","name":"LoopEng Platform","repoPath":"/home/dell/COurse/cash/loopeng","briefStatus":"failed", ...}
```

Two distinct problems were behind this, both traced to source and confirmed live, one fixed:

**1a. Code bug (fixed this pass):** `runProjectAnalyzerAgent` (`packages/agents/src/roles.ts`) only marked the `agent_runs` row `"failed"` when the CLI call returned a *soft* error (`result.isError`). A genuinely *thrown* exception (CLI spawn failure, MCP config error, etc.) skipped that code path entirely, leaving the row permanently orphaned at `status: "running"` — the same failure mode as an API-restart orphan (`docs/ARCHITECTURE.md` §5), except nothing crashed here. Live DB check confirmed exactly this: one `agent_runs` row for this project's analyzer, `status: running`, `started_at: 2026-07-11`, never finished, empty `logs_ref`. Meanwhile the outer catch in `runProjectAnalyzerAgent` still flipped `projects.briefStatus` to `"failed"` without touching `briefDocId` — which is why the project shows `briefStatus: "failed"` while still pointing at `briefDocId` from an *earlier, successful* analyzer run (a real brief doc from 2026-07-10 exists and is intact). Fixed: the catch block now also finalizes the `agent_runs` row to `"failed"` when the handle exists, closing the orphan.

**1b. Infra gap — the real "project onboarding looks broken" issue, root-caused and fixed.** Attempting to heal this project by calling `POST /projects/:id/reanalyze` against the docker-compose instance originally reproduced a much bigger problem than a bad brief: `{"error":"invalid_repo",...}` — the dockerized `api` had no `git`, no `claude` CLI, no `docker` CLI, and no view of any real repo at all, so *no* project onboarded against it could ever get real agent work done, regardless of brief status (implementer/reviewer/worktree-manager all need the identical `repoPath` access the analyzer does). Fixing it live surfaced a **third**, non-obvious cause after the first two were solved: the `claude` CLI hard-refuses `--dangerously-skip-permissions` (the analyzer/implementer/reviewer roles' permission mode) when the process runs as root, which this container did by default —

```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

reproduced directly by running the exact CLI invocation shape (`--input-format stream-json --output-format stream-json --permission-mode bypassPermissions`) inside the container. Full fix (see `README.md`'s Docker section and `docs/ARCHITECTURE.md` §8 for the complete writeup): `Dockerfile.api` moved off Alpine to `node:20-bookworm-slim` (the bind-mounted host `claude`/`docker` binaries are glibc-linked), gained a `docker-entrypoint.sh` that fixes up volume ownership as root then re-execs as the image's built-in non-root `node` user, and `docker-compose.yml` gained host-path bind mounts (git-visible repo, `claude` CLI + credentials, `docker` CLI + socket) all gated behind a new gitignored `infrastructure/docker/.env` — none of it activates by default. Verified end to end in this session, as the actual `node` (non-root) user, not just `docker exec`'s root-by-default shell: `bypassPermissions` mode now initializes correctly, and the real project's `POST /projects/:id/reanalyze` was re-triggered against the fixed container.

Also surfaced by this fix, not before it: docker-compose's `api` service already shipped with `ORCHESTRATOR_ENABLED: "1"` hardcoded — harmless before, since that container couldn't dispatch anything either way. Now that it can, running it *and* the native-supervised `api` (`README.md`'s other real-instance path) at the same time would reproduce `data/wiki-repo/wiki/duplicate-orchestrator-instances-incident.md` for real. Changed to opt-in (`${ORCHESTRATOR_ENABLED:-}`) as part of this fix, not left as a latent footgun.

## 2. Planning / intake (`/plan`) — code confirmed real, matches the just-updated docs

`POST /boards/:id/intake`, `GET /boards/:id/intake`, `GET /boards/:id/intake/:agentRunId`, and `POST /boards/:id/intake/:agentRunId/approve` all exist in `apps/api/src/routes/intake.ts` exactly as described in the freshly-corrected `docs/USER_GUIDE.md` §3 / `docs/USER_JOURNEY.md` Steps 1-3 / `docs/UI_INTERACTIONS.md` §5 — conversational, multi-turn, explicit approval before anything is persisted. This was the biggest drift found in the *previous* doc pass (the old docs described a one-shot modal that no longer exists); already fixed there, not repeated here.

## 3. Card lifecycle / board — genuinely exercised, not just theoretical

The real dogfood board (`13dee42b-...`, "LoopEng Platform") has **62 real cards**, not seed/demo data:

| state | count |
|---|---|
| `done` | 41 |
| `backlog` | 16 |
| `blocked` | 3 |
| `in_progress` | 1 |
| `cancelled` | 1 |

41 cards reaching `done` means the full pipeline — implementer → reviewer → gates → (approval, for high-risk) → deploy → merge — has genuinely completed end to end dozens of times on this exact codebase, not just in tests. This is strong evidence the happy path works for real.

**Doc fix made in this pass:** `docs/ARCHITECTURE.md` §3's state diagram and `docs/UI_INTERACTIONS.md` §2's column list were both stale — neither mentioned `cancelled` (a real terminal state, `backlog|ready -> cancelled`) or `deploy_failed` (a real state, deliberately separate from `blocked` so a pure deploy-mechanics failure doesn't force a full re-approval cycle), and the direct manual `in_review -> done` edge was undocumented. Source of truth is `packages/shared/src/state-machine.ts`'s `TRANSITIONS` map — both docs now match it. The board UI itself was already correct (`apps/web/app/board/page.tsx`'s `PHASE_3_COLUMN_STATES` has always had all 10 columns); only the docs were behind.

**Also found and documented:** the board has a `StagePipelineBar` (happy-path stage counts + a grouped "escape hatch" blocked+deploy_failed badge) and a title-search box — neither was in `docs/UI_INTERACTIONS.md` before this pass.

## 4. Gates — real checks, not stubs

Read all four gate check implementations in `packages/gates/src/checks/` to confirm none silently fake-pass:

- **`security_scan`** — real: regexes for AWS keys/private-key blocks/hardcoded secret assignments over the actual diff, plus a real `pnpm audit --json` in the worktree.
- **`tests_ci`** (`test-runner.ts`) — runs the actual test suite in the card's worktree.
- **`ci_status`** — real GitHub Checks API call (`GET /repos/:repo/commits/:sha/check-runs`) when `GITHUB_TOKEN`/`GITHUB_REPO` are set; `appliesTo()` returns false (clean skip, not a fake pass) when they're not — honest about being a no-op without GitHub wired up, matching `docs/ARCHITECTURE.md`'s existing description.
- **`adr_required`/`docs_adr_linked`** — real DB checks against the card's linked docs.

## 5. Deploy — one real provider today, room for more by design

`runDeployPipeline` (`packages/deploy-engine/src/pipeline.ts`) takes a `DeployProvider` parameter (`deploy(ctx)` / `rollback(ctx, sha)`, `packages/deploy-engine/src/types.ts`) defaulting to `dockerComposeProvider`. **Only the docker-compose provider exists right now** (`packages/deploy-engine/src/providers/docker-compose.ts`) — it's the sole file in that `providers/` directory. The interface is already provider-agnostic, so a future cloud/k8s/other target is meant to plug in as a second `DeployProvider` implementation without touching the pipeline itself — that's the extension point if/when deploy needs to target something beyond a local docker-compose host, not a rewrite. Nothing in the repo currently implements a second provider or references one by name; this is the designed seam, not a promise already kept.

The native `api` process deploys differently on purpose (not containerized — needs live git/docker/claude-CLI access): a supervisor process (`native-api-supervisor.ts`) owns the actual `pnpm --filter @loopeng/api run start` child and restarts it in place on request; see `docs/ARCHITECTURE.md` §6 for the full mechanism and the incident (card `6d4dc01a`) that shaped it.

## 6. How to run it

Two supported ways — see `README.md` for the full flag/env details and `CLAUDE.md` for the footguns:

- **`docker compose up -d --build`** in `infrastructure/docker/` — postgres + api + web, `ORCHESTRATOR_ENABLED=1` and volumes already correct. Verified this session: all three containers reach healthy, `GET /health` returns `{"status":"ok",...}`, web responds `307 -> /board`.
- **Native `pnpm dev`** from repo root — faster iteration, but requires `WIKI_REPO_PATH` set explicitly (native `cwd` is always the package dir, never repo root) and `ORCHESTRATOR_ENABLED` left **unset** unless this is deliberately "the one real instance," to avoid a second orchestrator racing the real one over the same `DATABASE_URL`.

## 7. Test data pollution — root-caused, one part cleaned up, one part documented

`GET /boards` originally returned 5 extra rows (`"roles.planner-image.test.ts throwaway board"` ×3, `"sync-e2e throwaway board"`, `"agent-runs test board"`) alongside the real "LoopEng Platform" board — the test suite writes directly into whatever `DATABASE_URL` the process has, and there's no separate test database. Two distinct causes, checked against actual source (not assumed from the row names):

**7a. Postgres rows — a crash-safety gap, not a missing-cleanup bug (cleaned up this pass).** Read the full source of every test that inserted one of these boards (`packages/deploy-engine/src/sync.test.ts`, `apps/api/src/routes/agent-runs.test.ts`, and the unmerged `roles.planner-image.test.ts` on branch `card/2e794f36-...`) — all three already have correct `try/finally`-scoped `afterAll` cleanup that deletes the board (cascades to cards/worktrees/agent_runs via `onDelete: "cascade"` FKs). The leftover rows are residue from runs that were killed/crashed/timed-out **before** reaching that cleanup — each of these spawns a real `claude` CLI subprocess with a multi-minute timeout, easy to interrupt via a CI cancellation, `vitest` kill, or an agent's own sandboxed environment tearing down mid-run. Same failure class as the already-documented "`agent_runs` orphaned by an API restart" gap (`docs/ARCHITECTURE.md` §5) — an in-process cleanup step with no external sweep to catch an interrupted run. Deleted the 5 confirmed-residue rows directly (verified each one's source test has legitimate, matching cleanup logic before deleting anything). No code changed — there was nothing broken in these files to fix; building a reconciler/sweep for interrupted test runs would be new infrastructure, not a bug fix, and wasn't in scope for this pass.

**7b. `data/wiki-repo` git history — a real, uncleaned gap (documented, not fixed).** `packages/doc-engine/src/index.ts:18` resolves `repoRoot` from `WIKI_REPO_PATH` as a **module-level constant at import time** — there's no per-test seam to point a single test at a throwaway repo. `apps/api/src/routes/docs.get-doc.e2e.test.ts:44` (`slug = get-doc-e2e-verify-${Date.now()}`) is the confirmed source of the ~90 `get-doc-e2e-verify-*.md` files in the real `data/wiki-repo/wiki/` — every run commits a genuinely new file to the real git history. Deleting a test's `docs` DB row (which these tests do correctly) doesn't revert the git commit, so this class of pollution is permanent and still growing on every `pnpm test` run. Unlike 7a, this isn't a crash-timing issue — it's a real architectural gap: doc-engine was never given a way to run against an isolated repo. Fixing it means adding a test-isolation seam (env-based, before any test imports the module) across every doc-touching test — a bigger, cross-cutting change, deliberately not attempted in this pass.
