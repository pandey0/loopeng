import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentRuns, db, pool } from "@loopeng/db";
import { buildSubAgentMcpConfig, MAX_DELEGATION_DEPTH, spawnSubAgent, SubAgentDepthExceededError } from "./sub-agent.js";

afterAll(async () => {
  await pool.end();
});

describe("buildSubAgentMcpConfig", () => {
  it("shapes an mcp-config that carries all context via env vars", () => {
    const config = buildSubAgentMcpConfig({
      parentAgentRunId: "run-1",
      cardId: "card-1",
      worktreeId: "worktree-1",
      cwd: "/some/worktree/path",
      depth: 1,
      disallowedTools: ["Edit", "Write"],
    });

    const servers = (config as { mcpServers: Record<string, unknown> }).mcpServers;
    const subagent = servers.subagent as { command: string; args: string[]; env: Record<string, string> };

    expect(subagent.command).toMatch(/tsx$/);
    expect(subagent.args[0]).toMatch(/mcp-subagent[/\\]src[/\\]server\.ts$/);
    expect(subagent.env).toMatchObject({
      LOOPENG_PARENT_AGENT_RUN_ID: "run-1",
      LOOPENG_CARD_ID: "card-1",
      LOOPENG_WORKTREE_ID: "worktree-1",
      LOOPENG_CWD: "/some/worktree/path",
      LOOPENG_DELEGATION_DEPTH: "1",
      LOOPENG_DISALLOWED_TOOLS: "Edit,Write",
    });
  });

  it("omits card/worktree ids and disallowed tools cleanly when absent", () => {
    const config = buildSubAgentMcpConfig({
      parentAgentRunId: "run-1",
      cardId: null,
      worktreeId: null,
      cwd: "/repo",
      depth: 1,
    });
    const subagent = (config as { mcpServers: { subagent: { env: Record<string, string> } } }).mcpServers.subagent;
    expect(subagent.env.LOOPENG_CARD_ID).toBe("");
    expect(subagent.env.LOOPENG_WORKTREE_ID).toBe("");
    expect(subagent.env.LOOPENG_DISALLOWED_TOOLS).toBe("");
  });
});

// This depth guard is the structural protection against runaway recursive
// delegation — it must reject *before* touching the DB or spawning a process,
// so a run stuck past the cap fails fast instead of hanging.
describe("spawnSubAgent depth guard", () => {
  it("refuses to spawn past MAX_DELEGATION_DEPTH without inserting a row or spawning a process", async () => {
    const bogusParentId = "00000000-0000-0000-0000-000000000000";

    await expect(
      spawnSubAgent({
        parentAgentRunId: bogusParentId,
        cardId: null,
        worktreeId: null,
        cwd: process.cwd(),
        depth: MAX_DELEGATION_DEPTH + 1,
        task: "this should never run",
        context: "",
      }),
    ).rejects.toThrow(SubAgentDepthExceededError);

    const rows = await db.select().from(agentRuns).where(eq(agentRuns.parentAgentRunId, bogusParentId));
    expect(rows).toHaveLength(0);
  });
});
