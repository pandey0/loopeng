# LoopEng

## Local Development

### Running via Turborepo (recommended)

```
pnpm dev
```

This runs `turbo run dev` from the repo root, which resolves each workspace's cwd correctly, including `apps/api`.

### Running `apps/api` natively

If you run `apps/api` directly (e.g. `pnpm --filter @loopeng/api dev`, or `tsx src/index.ts` from inside `apps/api`) instead of via `pnpm dev` from the repo root, you **must** set `WIKI_REPO_PATH` explicitly:

```
WIKI_REPO_PATH=<repo-root>/data/wiki-repo pnpm --filter @loopeng/api dev
```

`apps/api` defaults `WIKI_REPO_PATH` to `process.cwd()/data/wiki-repo`. Docker pins this correctly via a fixed volume, and `pnpm dev` from the repo root resolves cwd correctly via Turborepo. But a native run launched from any other cwd (e.g. from inside `apps/api`) will silently bootstrap a **new, empty** wiki-repo git checkout at that location instead of using the real one — every doc read/write then silently diverges from the canonical history at the real `data/wiki-repo`.
