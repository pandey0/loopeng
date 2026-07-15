import { Pool } from "pg";
import { describe, expect, it } from "vitest";

// Regression test for card 438646e5: migrations 0011/0012 created a
// loopeng_agent_runs Postgres role and handed its connection string to the
// sub-agent MCP server process (spawned inside an agent's own worktree, see
// buildSubAgentMcpConfig in @loopeng/agents) instead of the full-access
// DATABASE_URL. That was progress, but it was still a real Postgres
// credential reachable from an agent-worktree-adjacent process, with
// grants spanning every card's agent_runs rows (not scoped to the caller's
// own), and its fixed local-dev password sat in cleartext in .env.example.
// Migration 0013 revokes it outright: spawn_sub_agent and get_doc now talk
// to the authenticated API instead (apps/api/src/routes/agent-runs.ts),
// never a direct DB connection. This asserts the role is actually gone, not
// just unused -- a credential nothing legitimate points at any more is a
// straight liability if a future change quietly starts relying on it again.
const AGENT_RUNS_DATABASE_URL =
  process.env.AGENT_RUNS_DATABASE_URL ?? "postgresql://loopeng_agent_runs:loopeng_agent_runs_dev@localhost:5433/loopeng";

describe("loopeng_agent_runs role (revoked, card 438646e5 migration 0013)", () => {
  it("no longer exists -- connecting with its old credential fails authentication", async () => {
    const pool = new Pool({ connectionString: AGENT_RUNS_DATABASE_URL });
    await expect(pool.query("SELECT 1")).rejects.toThrow(/password authentication failed|role .* does not exist/i);
    await pool.end();
  });
});
