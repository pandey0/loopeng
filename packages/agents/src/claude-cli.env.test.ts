import { afterEach, describe, expect, it } from "vitest";
import { agentSpawnEnv } from "./claude-cli.js";

// Regression test for the 2026-07-03 incident (card 438646e5): an agent
// worktree's Bash tool inherited the full-access DATABASE_URL from this
// process's own env, so nothing stopped it from running `psql $DATABASE_URL`
// directly against the shared database -- exactly how an implementer
// created, then untraceably deleted, a card outside the API. agentSpawnEnv
// is what every `claude` CLI child (packages/agents/src/claude-cli.ts) is
// spawned with; this asserts the credential simply isn't in the env an
// agent's shell ever sees.
describe("agentSpawnEnv", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDbPort = process.env.DB_PORT;
  const originalOrchestratorEnabled = process.env.ORCHESTRATOR_ENABLED;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDbPort === undefined) delete process.env.DB_PORT;
    else process.env.DB_PORT = originalDbPort;
    if (originalOrchestratorEnabled === undefined) delete process.env.ORCHESTRATOR_ENABLED;
    else process.env.ORCHESTRATOR_ENABLED = originalOrchestratorEnabled;
  });

  it("strips DATABASE_URL, DB_PORT, and ORCHESTRATOR_ENABLED from the spawned child's env", () => {
    process.env.DATABASE_URL = "postgresql://loopeng:loopeng@localhost:5433/loopeng";
    process.env.DB_PORT = "5433";
    process.env.ORCHESTRATOR_ENABLED = "1";

    const env = agentSpawnEnv();

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DB_PORT).toBeUndefined();
    expect(env.ORCHESTRATOR_ENABLED).toBeUndefined();
  });

  it("leaves everything else (e.g. PATH, WIKI_REPO_PATH) untouched", () => {
    process.env.WIKI_REPO_PATH = "/data/wiki-repo";

    const env = agentSpawnEnv();

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.WIKI_REPO_PATH).toBe("/data/wiki-repo");
  });
});
