import { defineConfig } from "vitest/config";

// This package is a thin stdio entrypoint (server.ts runs `await
// server.connect(transport)` as a top-level side effect on import, so it
// can't be unit-tested by importing it directly -- it can only be exercised
// as a real spawned subprocess). Its real end-to-end coverage now lives in
// apps/api (agent-runs.e2e.test.ts, docs.get-doc.e2e.test.ts -- moved there
// in card 438646e5 once spawn_sub_agent/get_doc started talking to the API
// instead of the database directly) and its request-building logic is unit
// tested in packages/agents/src/sub-agent.test.ts. passWithNoTests keeps
// `pnpm test` green here rather than failing on "no test files found".
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
