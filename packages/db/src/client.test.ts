import { afterEach, describe, expect, it, vi } from "vitest";

// Regression test for card 438646e5: this module used to fall back to a
// hardcoded "postgresql://loopeng:loopeng@localhost:5432/loopeng" connection
// string when DATABASE_URL was unset -- a real, working-looking Postgres
// credential sitting directly in committed application source, reachable by
// anything that simply imports @loopeng/db regardless of whether the
// AGENT_ENV_DENYLIST (packages/agents/src/claude-cli.ts) had already
// stripped DATABASE_URL from the process env. That made the env-stripping
// fix hollow: stripping the var doesn't matter if the imported module just
// reconnects anyway. Asserts the module now fails loudly on first real use
// instead of silently falling back -- but only on use, not on import: the
// sub-agent MCP server process (packages/mcp-subagent/src/server.ts) pulls
// in @loopeng/agents' barrel export, which transitively imports this module,
// without ever touching the database itself, and must still be able to
// boot with no DATABASE_URL in its env at all.
describe("@loopeng/db client", () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    vi.resetModules();
  });

  it("importing the module succeeds even with no DATABASE_URL set", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    await expect(import("./client.js")).resolves.toBeDefined();
  });

  it("throws on first actual use rather than falling back to a hardcoded credential when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    const { db } = await import("./client.js");
    expect(() => db.select).toThrow(/DATABASE_URL is not set/);
  });
});
