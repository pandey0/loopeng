# LoopEng

## Local Development

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
