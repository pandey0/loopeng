# LoopEng

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component reference: monorepo layout, data model, card state machine, orchestrator loop, gates/deploy
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — day-to-day usage walkthrough
- [`docs/USER_JOURNEY.md`](docs/USER_JOURNEY.md) — one scenario end to end, UI click to code path
- [`docs/UI_INTERACTIONS.md`](docs/UI_INTERACTIONS.md) — full inventory of interactive UI elements and the API calls behind them
- [`docs/FLOWS.md`](docs/FLOWS.md) — every major flow checked against the actual running app, with what's real vs known-broken/gap
- [`CLAUDE.md`](CLAUDE.md) — project guide for Claude Code sessions working in this repo

## Architecture at a glance

pnpm/Turborepo monorepo: a Fastify API (`apps/api`, native process, port 4000), a Next.js 15 web frontend (`apps/web`, containerized, port 3000), and Postgres, orchestrating real `claude` CLI subprocesses that implement/review/plan work per Kanban card — full component/data-model/state-machine reference in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local Development

### Running the full stack (Docker)

Gets postgres + api + web up fast, with `ORCHESTRATOR_ENABLED=1` and volumes already wired correctly:

```
cd infrastructure/docker
docker compose up -d --build
```

Web on `http://localhost:3000`, API on `http://localhost:4000` (`/health` should return `{"status":"ok",...}`). Real secrets (`DB_PASSWORD`, `WEB_API_KEY`) go in a gitignored `infrastructure/docker/.env`; without one, compose falls back to the same local-dev defaults as `.env.example` — fine to start the app, not for anything meant to hold real data long-term.

**Real project work needs one extra setup step: `infrastructure/docker/.env`.** By default (no `.env`), this `api` container can serve board/card/doc CRUD against existing DB state, but the analyzer/implementer/reviewer/worktree/deploy pipeline can't run — the base image originally had no `git`, no `claude` CLI, no docker access, and no view of any real repo. All of that's now wired in via bind mounts, but every mount is a **host-specific path**, so it only activates once you set:

```
# infrastructure/docker/.env (gitignored -- create it, don't commit it)
HOST_REPO_ROOT=/absolute/path/to/this/repo/checkout
DOCKER_CLI_HOST_PATH=$(which docker)
DOCKER_COMPOSE_PLUGIN_HOST_DIR=~/.docker/cli-plugins
CLAUDE_CLI_HOST_SHARE_DIR=~/.local/share/claude
CLAUDE_CLI_HOST_BIN=~/.local/bin/claude
CLAUDE_CREDENTIALS_HOST_PATH=~/.claude/.credentials.json
DOCKER_GID=$(getent group docker | cut -d: -f3)
```

What each piece buys you, and what it costs:

- **`git` + `HOST_REPO_ROOT` bind-mounted at the identical absolute path** (not relocated) — makes a project's `repoPath` actually resolve inside the container, and gives the deploy step's Docker-outside-of-Docker calls path-identity with the host daemon they're driving.
- **`claude` CLI, bind-mounted from the host** (not baked into the image — it's a ~300MB glibc-linked binary that auto-updates; `Dockerfile.api` had to move off Alpine to `node:20-bookworm-slim` for glibc compatibility) **+ its OAuth credentials, read-only.** The credentials mount is sensitive on its own — anything that escapes this container gets this Claude account's session token.
- **`/var/run/docker.sock`**, so the deploy step can drive `docker compose --build web`. This is a real host privilege-escalation surface: socket access is equivalent to root on the host. Combined with the credentials mount above, a compromised container gets both.
- **Non-root by design, not accident**: the `claude` CLI hard-refuses `--dangerously-skip-permissions` (the analyzer/implementer/reviewer roles' permission mode) when running as root — confirmed live (`--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`). `docker-entrypoint.sh` fixes up volume ownership as root, then re-execs as the image's built-in non-root `node` user, which needs `DOCKER_GID` to match the host's `docker` group to use the socket mount at all.
- **`ORCHESTRATOR_ENABLED` is opt-in, not baked in** (unlike the old version of this file). This container and the native-supervised `api` below are **alternative** ways to run "the one real instance" — never run both with it set, or you'll reproduce `data/wiki-repo/wiki/duplicate-orchestrator-instances-incident.md` (two dispatchers racing the same `DATABASE_URL`).
- **"Local path" onboarding** now works, but only for paths under whatever `HOST_REPO_ROOT` you mounted — it was never going to be generically portable across arbitrary host paths.

Without `infrastructure/docker/.env`, none of this activates and you're back to UI/DB-only mode — that's a safe, valid way to run this stack too, just don't expect agents to do anything.

### Running via Turborepo

```
pnpm dev
```

This runs `turbo run dev` from the repo root, but Turbo (like `pnpm --filter`) still executes each workspace's task with `cwd` set to that package's own directory — `apps/api` for the api task, not the repo root.

### Running `apps/api` natively

For any native (non-docker) run of `apps/api` — including `pnpm dev` from the repo root, `pnpm --filter @loopeng/api dev`, or `tsx src/index.ts` from inside `apps/api` — you **must** set `WIKI_REPO_PATH` explicitly:

```
WIKI_REPO_PATH=<repo-root>/data/wiki-repo pnpm dev
```

`apps/api` defaults `WIKI_REPO_PATH` to `process.cwd()/data/wiki-repo`. Docker is the only setup where this is safe unset, since it pins `WIKI_REPO_PATH` to a fixed volume (`/data/wiki-repo`). Any native run — cwd is always the package directory (`apps/api`), never the repo root, regardless of where the command is invoked from — will silently bootstrap a **new, empty** wiki-repo git checkout at `apps/api/data/wiki-repo` instead of using the real one, and every doc read/write then silently diverges from the canonical history at the real `<repo-root>/data/wiki-repo`.

If this is the one real instance (not a worktree-local copy an agent spun up to eyeball a UI change), also set `ORCHESTRATOR_ENABLED=1` — it's opt-in, not opt-out, specifically so a stray worktree-local process can never auto-start a second dispatcher racing the real one over the same `DATABASE_URL`. Forgetting it doesn't error: the api serves board/card/doc CRUD completely normally, cards just never move on their own — nothing dispatches a `ready` card, nothing merges/deploys a `gate_checks` card past that stage. Confirmed live: a card dragged straight to `in_progress` sat there indefinitely with no live run and no explanation, purely because this was unset.

```
WIKI_REPO_PATH=<repo-root>/data/wiki-repo ORCHESTRATOR_ENABLED=1 pnpm dev
```

### Starting the one real instance

Don't start the real instance's native `api` with the plain `pnpm dev`/`tsx` command above -- run it under `packages/deploy-engine`'s supervisor instead, so the deploy pipeline can actually restart it after a merge (see `native-api-supervisor.ts`; card `6d4dc01a` -- without this, the native process just keeps running whatever code was loaded at last manual start, forever):

```
pnpm --filter @loopeng/deploy-engine run supervise:native-api <repo-root>
```

The supervisor sets `ORCHESTRATOR_ENABLED=1`/`WIKI_REPO_PATH`/etc. by inheriting whatever environment it's started with, then spawns and owns `pnpm --filter @loopeng/api run start` as its child -- SIGTERM+respawn on request (from a deploy) or on an unexpected crash.

## Deploying

Today, one real target: `web` is rebuilt and redeployed as a docker-compose service (`packages/deploy-engine/src/providers/docker-compose.ts`); the native `api` process is restarted in place by the supervisor above instead of being rebuilt, since it needs live git/docker/claude-CLI access a container image doesn't have. Both are driven by `runDeployPipeline` once a card reaches `deploying` — see `docs/ARCHITECTURE.md` §6 for the merge/health-check/rollback mechanics.

**Planned extension point, not yet built**: the pipeline already takes a `DeployProvider` (`deploy()`/`rollback()`) rather than hardcoding docker-compose — see `docs/FLOWS.md` §5. Deploying somewhere beyond a single docker-compose host (a real cloud target, k8s, etc.) is meant to be a second implementation of that interface, not a pipeline rewrite. No second provider exists in the repo yet.
