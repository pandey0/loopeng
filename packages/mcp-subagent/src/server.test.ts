import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentRuns, db, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, MAX_DELEGATION_DEPTH, runClaudeCli } from "@loopeng/agents";
import { afterAll, describe, expect, it } from "vitest";

// Real (non-mocked) end-to-end integration test. Drives the actual `claude`
// CLI with --mcp-config pointing at our real MCP server (spawned by the CLI
// itself, as tsx src/server.ts, exactly as buildSubAgentMcpConfig wires it in
// production) — no mocking of the tool call, the DB insert, or the nested
// sub-agent's own claude CLI run. Requires the `claude` CLI installed and
// authenticated (same requirement as the rest of this package's runtime deps).
describe("spawn_sub_agent MCP tool (real end-to-end)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("spawns a real sub-agent run whose result the parent uses in its own final answer", async () => {
    const [parent] = await db.insert(agentRuns).values({ status: "running" }).returning({ id: agentRuns.id });
    if (!parent) throw new Error("insert did not return a row");

    const marker = `ECHO-${randomUUID().slice(0, 8)}`;
    const mcpConfig = buildSubAgentMcpConfig({
      parentAgentRunId: parent.id,
      cardId: null,
      worktreeId: null,
      cwd: process.cwd(),
      depth: 1,
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    });

    const prompt = [
      `Call the spawn_sub_agent tool exactly once with task "Reply with exactly the text ${marker} and nothing else" and context "".`,
      `Take the sub-agent's returned text and reply with exactly: PARENT-GOT: <that text>`,
      "Do not add any other words.",
    ].join(" ");

    const result = await runClaudeCli({
      cwd: process.cwd(),
      prompt,
      permissionMode: "bypassPermissions",
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
      mcpConfig,
    });

    try {
      expect(result.isError).toBeFalsy();
      // Proves the parent actually received and used the sub-agent's own output,
      // not just that it called the tool.
      expect(result.resultText).toContain(marker);

      const subRuns = await db.select().from(agentRuns).where(eq(agentRuns.parentAgentRunId, parent.id));
      expect(subRuns).toHaveLength(1);
      const subRun = subRuns[0];
      if (!subRun) throw new Error("expected a sub-agent run row");
      expect(subRun.parentAgentRunId).toBe(parent.id);
      expect(subRun.status).toBe("succeeded");
      expect(subRun.worktreeId).toBeNull(); // matches parent's (worktree-less test context)
    } finally {
      await db.delete(agentRuns).where(eq(agentRuns.parentAgentRunId, parent.id));
      await db.delete(agentRuns).where(eq(agentRuns.id, parent.id));
    }
  }, 180_000);

  it("returns a clear tool error (not a hang) when delegation depth is already at the cap", async () => {
    const [parent] = await db.insert(agentRuns).values({ status: "running" }).returning({ id: agentRuns.id });
    if (!parent) throw new Error("insert did not return a row");

    // Simulate this run already being at the deepest allowed level: the next
    // spawn_sub_agent call would create a run one past MAX_DELEGATION_DEPTH.
    const mcpConfig = buildSubAgentMcpConfig({
      parentAgentRunId: parent.id,
      cardId: null,
      worktreeId: null,
      cwd: process.cwd(),
      depth: MAX_DELEGATION_DEPTH + 1,
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
    });

    const prompt = [
      'Call the spawn_sub_agent tool exactly once with task "hello" and context "".',
      "Whatever it returns (including an error), reply with exactly: TOOL-SAID: <its exact text>",
    ].join(" ");

    const result = await runClaudeCli({
      cwd: process.cwd(),
      prompt,
      permissionMode: "bypassPermissions",
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash"],
      mcpConfig,
    });

    try {
      expect(result.resultText.toLowerCase()).toMatch(/depth|exceed/);

      const subRuns = await db.select().from(agentRuns).where(eq(agentRuns.parentAgentRunId, parent.id));
      expect(subRuns).toHaveLength(0);
    } finally {
      await db.delete(agentRuns).where(eq(agentRuns.id, parent.id));
    }
  }, 180_000);
});
