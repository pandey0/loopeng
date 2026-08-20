# loopeng — Claude Code guide

Self-hosted internal developer platform: a Confluence-style docs wiki + a Kanban dev-cycle board + real AI coding-agent orchestration (real `claude` CLI subprocesses do the actual implementation/review/planning per card), all in one pnpm/Turborepo monorepo.

**Read `docs/ARCHITECTURE.md` first for anything non-trivial.** It's the authoritative "how it's built" reference (data model, state machine, orchestrator loop, gates, deploy pipeline, known gaps) and is kept current — don't re-derive that from scratch by grepping the codebase.

## Doc map

| File | What it's for |
|---|---|
| `docs/ARCHITECTURE.md` | Component reference: monorepo layout, data model, card state machine, orchestrator loop, agent execution, gates/deploy, known architectural gaps |
| `docs/USER_GUIDE.md` | Day-to-day usage walkthrough, product-facing |
| `docs/USER_JOURNEY.md` | One narrative scenario tying UI clicks to the exact code path underneath |
| `docs/UI_INTERACTIONS.md` | Full inventory of every interactive UI element, page by page, with the API call it triggers |
| `architecture.drawio` | Visual version of the architecture map |
| `README.md` | Local dev setup — read this before running anything natively |

If you change behavior these docs describe (routes, state machine transitions, gate keys, page structure), update the relevant doc in the same change — this repo's own gate pipeline (`docs_adr_linked`) and its own history (see `docs/ARCHITECTURE.md` §8) exist specifically because undocumented architecture drift has caused real incidents here before.

## Monorepo layout

pnpm workspaces + Turborepo (`pnpm@9.12.0`, Node >=20), TypeScript throughout, Drizzle ORM/Postgres, Fastify API, Next.js 15 App Router web, Tailwind + shadcn-style components.

```
apps/
  api/     Fastify server, port 4000 — runs natively, NOT containerized
  web/     Next.js 15 frontend, port 3000 — containerized
packages/
  shared/            zod schemas, enums, card state machine
  db/                Drizzle schema + client, migrate/seed CLI
  ui/                React component library
  board-engine/      card state machine application, blockedReason computation
  doc-engine/        git-backed markdown docs (frontmatter + commit history)
  worktree-manager/  git worktree lifecycle per card
  agents/            claude CLI process spawner, agent role prompts, session registry
  gates/             quality gate pipeline
  deploy-engine/     merge -> deploy -> health-check -> rollback pipeline
  connectors/        notification/action registry (github/slack/linear)
  orchestrator/      cron + event dispatch, the autonomous run loop
  mcp-subagent/      MCP server exposing spawn_sub_agent to a running claude CLI session
```

Full dependency graph and data model: `docs/ARCHITECTURE.md` §1-2.

## Commands

```
pnpm dev          # turbo run dev — all workspaces, each with cwd set to its own package dir
pnpm build        # turbo run build
pnpm lint         # turbo run lint
pnpm test         # turbo run test (vitest)
pnpm typecheck    # turbo run typecheck
pnpm db:generate  # drizzle-kit generate (packages/db)
pnpm db:migrate   # packages/db migrate CLI
pnpm db:seed      # packages/db seed CLI
```

Scope any of these to one workspace with `pnpm --filter @loopeng/<name> run <script>` (e.g. `@loopeng/api`, `@loopeng/web`, `@loopeng/db`, `@loopeng/agents`).

## Running the app — read this before you `pnpm dev`

Full details, including *why*: `README.md`. The short version, because getting this wrong silently corrupts state rather than erroring:

- Any native run of `apps/api` (`pnpm dev` from root, `pnpm --filter @loopeng/api dev`, `tsx src/index.ts`) **must** set `WIKI_REPO_PATH` explicitly to `<repo-root>/data/wiki-repo`. Its default is `process.cwd()/data/wiki-repo`, and native `cwd` is always `apps/api`, never the repo root — an unset var silently bootstraps a throwaway empty wiki checkout instead of using the real one.
- Only set `ORCHESTRATOR_ENABLED=1` for "the one real instance." It's opt-in specifically so a worktree-local dev/verification process never races the real orchestrator over the same `DATABASE_URL`. Forgetting it on the real instance doesn't error — cards just never move on their own.
- Don't start the real instance's native `api` with plain `pnpm dev`/`tsx` — use `pnpm --filter @loopeng/deploy-engine run supervise:native-api <repo-root>` so the deploy pipeline can actually restart it after a merge.
- The full stack (postgres + api + web) can also run via `docker compose` in `infrastructure/docker/` — see `infrastructure/docker/docker-compose.yml`. That's the safer default for "just start the app to look at it," since it has `ORCHESTRATOR_ENABLED=1` and correct volumes baked in already.

## Conventions and gotchas worth knowing before editing

- **Card state machine** is defined once in `packages/shared/src/state-machine.ts`; every transition goes through `applyTransition` in `board-engine`. Don't hand-roll a state write elsewhere.
- **Auth**: every card/board/project/doc/intake-mutating route requires a verified `api_keys` bearer token; `actorType`/`actorId` are derived server-side from that token, never trusted from the request body (`apps/api/src/plugins/auth.ts`). See `docs/ARCHITECTURE.md` §8 for the incident this hardened against.
- **Agent-spawned processes never get `DATABASE_URL`** (`agentSpawnEnv` in `@loopeng/agents`) — they talk to state only through the authenticated API with a per-run-scoped `CARD_API_KEY`. Don't reintroduce a direct DB path from inside a worktree/sub-agent.
- **`packages/db`'s client has no hardcoded fallback connection string** — an unset `DATABASE_URL` throws (lazily, on first real use) rather than silently reconnecting to a baked-in credential. Keep it that way.
- Real secrets (`DB_PASSWORD`, `WEB_API_KEY`) belong in a gitignored `infrastructure/docker/.env`, never in a committed file — `.env.example` at root is a local-dev-only default, not a template to fill with real values in-repo.
- The `web` container is rebuilt-and-swapped on deploy; the native `api` process is restarted-in-place via a separate supervisor process, on purpose (`docs/ARCHITECTURE.md` §6) — don't assume both deploy the same way.
