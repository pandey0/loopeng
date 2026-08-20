# loopeng Architecture

Self-hosted internal developer platform: Confluence-style docs wiki + Kanban dev-cycle board + real AI coding-agent orchestration, all in one monorepo. Real `claude` CLI subprocesses do actual implementation/review/planning work per card, gated by automated checks before anything reaches production. See `../architecture.drawio` for the visual version of this map, and `USER_GUIDE.md` for the day-to-day usage walkthrough. This file is the "how it's built" reference.

## 1. Monorepo layout

pnpm workspaces + Turborepo (`pnpm@9.12.0`, Node >=20), TypeScript throughout, Drizzle ORM against Postgres, Fastify API, Next.js 15 App Router web, Tailwind + shadcn-style components.

```
apps/
  api/     Fastify server, port 4000 -- runs as a native process, NOT containerized
  web/     Next.js 15 frontend, port 3000 -- containerized, rebuilt on every deploy
packages/
  shared/            zod schemas, enums, card state machine -- zero internal deps
  db/                Drizzle schema + client, migrate/seed CLI
  ui/                React component library (CardTile, Column, DocViewer, dialogs, etc.)
  board-engine/      card state machine application, blockedReason/activeAgentRun computation
  doc-engine/        git-backed markdown docs (frontmatter + commit history)
  worktree-manager/  git worktree lifecycle per card, diffing against base commit
  agents/            claude CLI process spawner, agent role prompts, session registry
  gates/             quality gate pipeline (tests, security, docs, CI, design)
  deploy-engine/      merge -> deploy -> health-check -> rollback pipeline
  connectors/        notification/action registry (github/slack/linear stubs)
  orchestrator/      cron + event dispatch triggers, the autonomous run loop
  mcp-subagent/       MCP server exposing spawn_sub_agent to a running claude CLI session
```

Internal dependency direction (no cycles):

```
shared  <-  everything
db      <-  agents, board-engine, connectors, deploy-engine, doc-engine, gates, mcp-subagent, orchestrator
ui      <-  web
board-engine    <-  api, orchestrator
doc-engine      <-  agents, api, orchestrator
worktree-manager <- agents, deploy-engine, gates, orchestrator, api
agents          <-  api, mcp-subagent, orchestrator
orchestrator    <-  api
```

## 2. Data model (Postgres via Drizzle)

Core entities, roughly grouped:

- **users** -- id, email, name, role (admin/member/viewer)
- **boards** -- a Kanban board; **cards** -- boardId, title, state, cardType (epic/feature/bug/chore/spike), riskTier (low/medium/high), priority, tags, assigneeId, agentRoleId, worktreeId, acceptanceCriteria
- **card_dependencies** -- blocks/relates_to edges between cards (cycle-checked)
- **card_doc_links** -- links a card to a doc with a linkType (spec/adr/skill/related)
- **card_questions** -- QUESTION: escalations an agent raises mid-run (open/answered), with routedTo (human vs tech-manager) and answer
- **docs** -- slug, docType (wiki/adr/rfc/skill), status (draft/proposed/accepted/superseded/deprecated), repoPath, latestCommitSha; **doc_versions** -- git commit history cache; **adrs**/**skills** -- 1:1 type-specific extension tables
- **agent_roles** -- implementer/reviewer/planner/manager/designer etc., capabilities + model config
- **agent_runs** -- cardId, agentRoleId, worktreeId, parentAgentRunId (sub-agent delegation), status (queued/running/succeeded/failed/verifying), verdict, transcript (jsonb, incrementally appended stream events)
- **worktrees** -- one git worktree per active card: repoUrl, branchName, fsPath, baseCommitSha, status (creating/active/merged/torn_down/failed)
- **gate_definitions** -- key, name, blocking, config, enabled; **gate_results** -- cardId, gateDefinitionId, status (pending/running/passed/failed/skipped), detail (jsonb), runByAgentRunId/runByUserId
- **deploy_records** -- cardId, environment, status (pending/deploying/live/rolled_back/failed), deployedCommitSha, deployUrl, rollbackOfDeployId
- **event_log** -- append-only audit trail: entityType/entityId, eventType, actorType (user/agent/automation), payload -- everything the activity feed and SSE stream read from
- **automations**/**automation_runs**/**connectors** -- cron/event/webhook trigger definitions and their run history (Phase 2+ groundwork)

**`GET /projects/:id/export`** (`apps/api/src/routes/projects.ts`) -- read-only JSON snapshot of a project's cards (any `cardType`, epics included). 404s if the project doesn't exist. Response body:

```
{
  schemaVersion: 1,
  exportedAt: "<ISO timestamp>",
  project: { id, name },
  cards: [ { ...full cards row fields..., epicId: string | null }, ... ]
}
```

`epicId` is derived the same way `GET /cards` derives it (first `relates_to` dependency edge), computed directly here rather than via `attachCardStatus` so the export doesn't also leak `activeAgentRun`/`blockedReason` activity data. No docs, comments, or activity are included -- just the cards table's own columns plus that one derived field. Bump `EXPORT_SCHEMA_VERSION` in the route file whenever the shape changes.

## 3. Card lifecycle (the state machine)

Defined once in `packages/shared/src/state-machine.ts`, enforced by `board-engine`'s `applyTransition`:

```
backlog -> ready -> in_progress -> in_review -> gate_checks -> awaiting_approval -> deploying -> done
  |          |           |             |  \          |               |
  v          v           v             |   -----------+---------------+--------------> done (direct, manual)
cancelled cancelled    blocked <-------+                               |
                                                                     deploying -> deploy_failed -> deploying | blocked
blocked -> in_progress | ready
```

Full edge list is `TRANSITIONS` in `packages/shared/src/state-machine.ts` — the diagram above is the happy path plus the two exit lanes; the source is the ground truth if they ever diverge.

- `backlog -> ready`: a human decides a card is actually next up (or the planner/manager already dropped it in `backlog` and a human promotes it).
- `backlog -> cancelled` / `ready -> cancelled`: a human decides the work isn't happening. Terminal, same as `done` — cancelled cards don't get a board column (§7 has the full list of columns actually rendered).
- `ready -> in_progress`: orchestrator dispatch (cron sweep or event trigger) picks it up, creates/reuses a worktree, kicks off the implementer.
- `in_progress -> in_review`: implementer finished without erroring; a reviewer sub-agent verifies the diff independently.
- `in_review -> gate_checks`: reviewer verdict was `pass`; the automated gate pipeline runs.
- `in_review -> done`: a direct manual edge for a human moving a card by hand with no gate pipeline involved — not something the orchestrator itself ever does.
- `gate_checks -> awaiting_approval` (high risk) or `-> deploying` (low/medium risk): all blocking gates passed.
- `awaiting_approval -> deploying`: a human clicks "Review & Approve" after inspecting the diff, reviewer transcript, and gate results.
- `deploying -> done`: deploy pipeline merged, deployed, and health-checked successfully; worktree torn down.
- `deploying -> deploy_failed`: a deploy-mechanics failure (pre-check, transient docker error, flaky health check) *after* implementer/reviewer/gates/approval already passed. Deliberately a separate lane from `blocked`, not folded into it: `blocked -> ready` re-runs the *entire* implementer -> reviewer -> gates -> approval cycle, which would force a human to re-approve code that never actually changed for a pure infra hiccup.
- `deploy_failed -> deploying`: retry just the deploy step directly (the card detail page's default "next step" action for a `deploy_failed` card).
- `deploy_failed -> blocked`: a human decides the failure *does* need a code change, not just a deploy retry — sends it through the full cycle instead.
- `in_progress|in_review|gate_checks|awaiting_approval -> blocked`: implementer/reviewer failure after retries exhausted, a gate failed, or an open QUESTION: -- see Section 6.
- `blocked -> ready`: manual (or, once fixed, automatic) recovery re-queues the card for dispatch.

## 4. The autonomous run loop (`packages/orchestrator`)

`startOrchestrator()` wires two dispatch triggers onto one shared `HierarchicalStrategy` (concurrency=1; serial in-process queue when `REDIS_URL` is unset, BullMQ+Redis otherwise):

- **Cron trigger** -- a periodic sweep (includes a once-daily "morning triage" pass) that finds `ready` cards and dispatches them.
- **Event trigger** -- watches `event_log` for card-state-change events and dispatches newly-`ready` cards immediately, keyed off a `lastId` cursor. Caveat: this cursor initializes to the *current max* `event_log.id` at boot, so any card that became `ready` before the process last started is invisible to event-driven dispatch until the next cron sweep or a manual `POST /cards/:id/dispatch` (tracked as a known gap, backlog card `59b39294`).

Per-card dispatch is `orchestrateCard()` in `packages/orchestrator/src/loop.ts`:

1. Create or reuse the card's worktree (isolated git branch/checkout).
2. Transition to `in_progress`, run the **implementer** agent (up to 3 attempts, each retry seeded with the previous failure/rejection as context).
3. If the implementer raises a `QUESTION:`, insert a `card_questions` row, route it (human vs tech-manager depending on whether the card's epic went through manager review), transition to `blocked`, and stop -- this does not consume a retry attempt.
4. On implementer success, transition to `in_review`, run the **reviewer** sub-agent against the diff; its verdict is recorded as the `peer_review` gate. A `fail` verdict retries (back to `in_progress` with the rejection as feedback) until attempts are exhausted, then blocks.
5. On reviewer `pass`, transition to `gate_checks`, run the gate pipeline (Section 5).
6. All blocking gates passing routes by `riskTier`: `high` -> `awaiting_approval` (human must approve); `low`/`medium` -> `deploying` (deploy pipeline runs automatically, Section 6).

`HookRegistry` fires lifecycle hooks (`beforeCardPickup`, `afterWorktreeCreated`, `beforeSubAgentVerify`, `afterGateRun`, `beforeDeploy`, `onFailure`) that connectors and future automations subscribe to.

**Enabling the loop**: cron/event dispatch is opt-in, not opt-out -- an API process only wires both triggers if `ORCHESTRATOR_ENABLED=1` is set in its environment (see `apps/api/src/plugins/orchestrator.ts`). Only the one real instance (`infrastructure/docker/docker-compose.yml`) sets it; a worktree-local/dev copy of `apps/api` boots with dispatch off by default, so it can serve boards/cards/docs CRUD without racing the real orchestrator over the same `DATABASE_URL`. Without it set, cards stay wherever they are, no new dispatch happens, but the API itself keeps serving requests.

## 5. Agent execution (`packages/agents`)

Each agent role (`implementer`, `reviewer`, `planner`, `manager`/tech-manager, `designer`) is a real `claude` CLI subprocess launched via `runClaudeCliStreamingOnce`/`runClaudeCliStreaming`, with:

- A role-specific system prompt (`packages/agents/src/prompts` + `roles.ts`) describing the task, constraints, and (for implementer/reviewer) the worktree it's confined to.
- An MCP server config (`@loopeng/mcp-subagent`) giving the session a `spawn_sub_agent` tool -- it can delegate a sub-task to a fresh agent in the same worktree and block on the result, recorded as a child `agent_runs` row via `parentAgentRunId`.
- Streaming output captured incrementally into `agent_runs.transcript` (jsonb array of stream events) via `makeTranscriptAppender`, so a UI can replay-then-follow a run live.
- A process-local `sessionRegistry` (`Map<agentRunId, StreamingSession>`) that a WebSocket route (`GET /agent-runs/:id/socket`) attaches to for live viewing/interactive input, and that a snippet extractor (`getSessionSnippet`) scans backwards through for a short "what's it doing right now" string shown on the board.

**Planner** (`startPlannerAgent`) is the intake entrypoint: given a freeform product-owner request, it drafts a spec doc and a dependency-linked epic + child-card decomposition, landing every leaf card in `backlog`. It runs as a non-blocking background task (`POST /boards/:id/intake` returns `202` with just an `agentRunId`; the frontend polls `GET /boards/:id/intake/:agentRunId` and streams the live session meanwhile).

**Manager** (`runManagerAgent`, tech-manager role) runs once per freshly-decomposed epic, read-only against the main repo checkout (no worktree of its own), and may adjust the planner's breakdown (split/merge/reprioritize) before a human ever sees it. It's the first-line escalation target for QUESTION:s raised on cards under its reviewed epics.

Because `sessionRegistry` and the orchestrator's in-flight run state are process-local, an API restart orphans anything mid-run: the detached `claude` child process may keep going, but nothing is listening to its output anymore, and the `agent_runs` row stays stuck at `running`/`verifying` forever unless manually recovered.

## 6. Gates and deploy (`packages/gates`, `packages/deploy-engine`)

Gate pipeline (`runGatePipeline`, called from the orchestrator loop at `gate_checks`) iterates every enabled `gate_definitions` row except `peer_review` and `deploy_live` (those are written by their owning phase instead), running each check's `appliesTo()`/`run()` and always inserting a `gate_results` row -- passed, failed, or skipped -- before moving on. Known gate keys: `tests_ci`, `security_scan`, `docs_adr_linked`, `adr_required`, `ci_status`, `design_review`, plus the pipeline-external `peer_review` (mirrors the reviewer sub-agent's verdict) and `deploy_live` (a real trial deploy + health check, separate from the human-approved production deploy).

Deploy pipeline (`runDeployPipeline` / `docker-compose.ts` provider) runs once a card reaches `deploying`: checks the target repo is on the expected base branch and clean (refuses with a clear `detail.reason` like `"repo has uncommitted changes, refusing to merge"` otherwise -- a deliberate safety check, not a bug), merges the worktree branch with `--no-ff`, rebuilds and redeploys the `web` container via `docker compose ... --build web`, health-checks it, and either tears the worktree down as `merged` (-> card `done`) or rolls back to the pre-merge commit and blocks the card for a human.

**Important asymmetry**: `COMPOSE_SERVICES` defaults to `["web"]` only -- the native `api` process is deliberately excluded (documented in code) because it needs live git/docker/claude-CLI access a container image doesn't have. Since the native process can't be rebuilt-and-swapped the way `web`'s container is, the deploy pipeline instead restarts it explicitly: `native-api.ts` requests a restart via a file `native-api-supervisor.ts` watches (a small standalone process that owns the actual `pnpm --filter @loopeng/api run start` child, SIGTERM+respawn), then polls `/health` until it reports a new `bootId` -- proof a fresh process actually took over, not just that the old one is still answering (a plain DB-connectivity check can't tell the difference, which is exactly how card `6d4dc01a`'s 3-day-stale-api incident went unnoticed). The supervisor runs as its own OS process, separate from the api process it supervises, so a deploy triggered from inside that api process's own orchestrator never has to SIGTERM itself mid-deploy.

## 7. Live visibility features

- **Board-level**: cards actively being worked show a live one-line snippet (last tool call / reasoning excerpt) and a "watch" button opening a read-only session panel, polling only while at least one card has an active run (`ACTIVE_RUN_POLL_MS`).
- **Card detail**: gate results render their full `detail` payload in a collapsible section, auto-expanded and red-bordered for failure-like statuses.
- **Approval dialog**: "Review & Approve" opens the full picture before a human commits to production -- risk/architecture badges, the latest reviewer run's complete transcript, every gate result, the actual repo diff (`GET /cards/:id/diff`), and linked docs -- not just a bare button.
- **Intake**: the planner's live session streams into the intake modal instead of a spinner, so a product owner sees the decomposition happening in real time.
- **blockedReason**: computed fresh (never stored) by picking whichever of the most recent failing gate, failed/rejected agent run, open question, or stuck running/verifying run explains the block; falls back to an explicit "no recorded cause" message rather than ever showing blank/None (`packages/board-engine/src/card-status.ts`).

## 8. Known architectural gaps (tracked, not yet fixed)

- Event-trigger cursor skips `ready`-transitions from before process boot (backlog `59b39294`).
- A card stalled mid-`gate_checks` by a process restart has no automatic recovery path (needs its own backlog card).
- ~~Agents have unrestricted raw DB access with no actor authentication~~ -- fixed (backlog `438646e5`): agent-spawned processes no longer get `DATABASE_URL` at all, in any form (`agentSpawnEnv` in `@loopeng/agents`). The sub-agent MCP server process's `agent_runs` bookkeeping and `get_doc` reads used to run through a least-privilege `loopeng_agent_runs` Postgres role instead (migrations 0011/0012) -- that role's grants were table-wide across every card, not scoped to the caller's own, and its fixed local-dev password sat in cleartext in `.env.example`; migration 0013 revokes it outright, and that subprocess now calls `POST /agent-runs` / `POST /agent-runs/:id/finish` / `GET /docs/:slug` over the same authenticated API (`apps/api/src/routes/agent-runs.ts`) with its own single-run-scoped `CARD_API_KEY`, same as everything else here. Every card/board/project/doc/intake-mutating route requires a verified `api_keys` bearer token (`apps/api/src/plugins/auth.ts`), with `actorType`/`actorId` derived server-side from that token rather than trusted from the request body. Board-shaping routes with no single card to scope to (`boards`, `projects`, `docs`, `intake`) require a verified human (`requireHumanActor`); card-mutating routes additionally 403 an agent-scoped credential targeting any card other than the one its key was minted for (`requireOwnCard`), auditing the attempt as `card.access_denied`. Every agent run -- top-level and every sub-agent it delegates to -- gets its own single-run-scoped `CARD_API_KEY` (`runApiKeyEnv` in `@loopeng/agents`) instead of a shared credential; `POST /agent-runs` always inherits its caller's own card/project/board scope server-side (never a client-suppliable value), and both creating and finishing a sub-agent run land in `event_log` (`agent_run.delegated`/`agent_run.completed`). Stripping `DATABASE_URL` from spawned processes was still hollow while the credential itself was recoverable with a plain file read: `packages/db/src/client.ts` used to fall back to a hardcoded, working connection string when the env var was absent, and `infrastructure/docker/docker-compose.yml` hardcoded the same Postgres password `DATABASE_URL` itself used for "the one real instance" -- either was enough to reconstruct raw DB access from inside any agent worktree with nothing more than a `cat`. The client now has no fallback (it throws on first real use, lazily, so modules that only import it transitively -- like the sub-agent MCP server pulling in `@loopeng/agents`'s barrel export -- still load fine with no `DATABASE_URL` at all), and the compose file's Postgres password is parameterized (`${DB_PASSWORD:-loopeng}`, same pattern as `WEB_API_KEY`) so a real deployment's actual credential lives only in a gitignored `infrastructure/docker/.env`, never in a committed file.
- Agents occasionally create their own scaffolding/verification cards as part of a task (e.g. "e2e: add a muted Badge variant") -- known, deliberately not suppressed.
- ~~The dockerized `api` cannot do real project work at all~~ -- fixed (see `docs/FLOWS.md` §1 for the full diagnosis and `README.md`'s Docker section for setup). Three compounding gaps, all confirmed live: no `git`/`claude`/`docker` CLI in the image, no view of any real repo, and -- found only after fixing the first two -- the `claude` CLI hard-refuses `--dangerously-skip-permissions` (the analyzer/implementer/reviewer roles' permission mode) when running as root, which this container did by default. Fixed by moving `Dockerfile.api` off Alpine to `node:20-bookworm-slim` (the `claude`/`docker` binaries bind-mounted in from the host are glibc-linked, won't run on musl), bind-mounting `git`/`claude`/`docker` access and a `HOST_REPO_ROOT`-identical repo path in, and adding `docker-entrypoint.sh` to fix up volume ownership as root then re-exec as the image's non-root `node` user (`DOCKER_GID`-matched into a group that can use the `/var/run/docker.sock` mount). All of it is opt-in via `infrastructure/docker/.env` (gitignored, host-specific paths) -- without it, this container is still safely UI/DB-only, same as before.
- **This makes the "two real instances" collision risk (`data/wiki-repo/wiki/duplicate-orchestrator-instances-incident.md`) newly reachable, not just theoretical.** Before this fix, the dockerized `api`'s `ORCHESTRATOR_ENABLED: "1"` was harmless -- the container couldn't dispatch anything regardless. Now that it can, docker-compose and the native-supervised `api` (`README.md` "Starting the one real instance") are genuinely two *alternative* ways to run "the one real instance," and running both against the same `DATABASE_URL` with dispatch enabled reproduces that exact incident. `ORCHESTRATOR_ENABLED` was changed from hardcoded `"1"` to opt-in (`${ORCHESTRATOR_ENABLED:-}` in `docker-compose.yml`) specifically so enabling this mode is a conscious choice, not a default that silently collides with whichever instance you already have running. There's no code-level mutual exclusion beyond that -- it's a documented operational rule, not an enforced one.
- **Also newly true: mounting `/var/run/docker.sock` and the `claude` CLI's OAuth credentials into this container is a real, understood privilege-escalation surface** -- socket access is equivalent to host root; combined with the credentials mount, anything that escapes this container gets both. This is an accepted tradeoff for this container getting deploy/agent parity, not an oversight -- see `README.md`'s Docker section for the full reasoning before enabling it.
