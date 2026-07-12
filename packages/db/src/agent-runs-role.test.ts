import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression test for card 438646e5: the sub-agent MCP server process
// (spawned inside an agent's own worktree, see buildSubAgentMcpConfig in
// @loopeng/agents) is threaded the loopeng_agent_runs role's credential
// instead of the full-access DATABASE_URL -- migration 0011/0012 is what
// actually creates that role and its grants. This connects as that role for
// real (not a mock) and asserts the grants are exactly what they should be:
// read/write agent_runs, read-only agent_roles and docs, and nothing else
// in the shared database.
const AGENT_RUNS_DATABASE_URL =
  process.env.AGENT_RUNS_DATABASE_URL ?? "postgresql://loopeng_agent_runs:loopeng_agent_runs_dev@localhost:5433/loopeng";

describe("loopeng_agent_runs scoped role", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: AGENT_RUNS_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("can read and write agent_runs", async () => {
    await expect(pool.query("SELECT count(*) FROM agent_runs")).resolves.toBeDefined();
  });

  it("can read agent_roles and docs", async () => {
    await expect(pool.query("SELECT count(*) FROM agent_roles")).resolves.toBeDefined();
    await expect(pool.query("SELECT count(*) FROM docs")).resolves.toBeDefined();
  });

  it("cannot read cards -- the exact table the 2026-07-03 incident's raw DELETE hit", async () => {
    await expect(pool.query("SELECT count(*) FROM cards")).rejects.toThrow(/permission denied/);
  });

  it("cannot mutate cards even if a read happened to be allowed", async () => {
    await expect(pool.query("DELETE FROM cards")).rejects.toThrow(/permission denied/);
  });

  it("cannot read event_log, boards, users, or api_keys", async () => {
    for (const table of ["event_log", "boards", "users", "api_keys"]) {
      await expect(pool.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});
