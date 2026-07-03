import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSubAgent, SubAgentDepthExceededError } from "@loopeng/agents";

// This process is spawned per-session by the `claude` CLI (via --mcp-config,
// see buildSubAgentMcpConfig in @loopeng/agents) — one instance per running
// agent, not shared across runs. All the context it needs about the run that
// spawned it travels in via env vars set on that spawn, rather than an IPC/
// HTTP call back to the API process: this script has the same workspace
// access to @loopeng/db and @loopeng/agents that the API does, so it can do
// the sub-agent's DB insert + streaming run directly in-process.
interface SubAgentEnvContext {
  parentAgentRunId: string;
  cardId: string | null;
  worktreeId: string | null;
  cwd: string;
  depth: number;
  disallowedTools: string[] | undefined;
}

function readEnvContext(): SubAgentEnvContext {
  const parentAgentRunId = process.env.LOOPENG_PARENT_AGENT_RUN_ID;
  const cwd = process.env.LOOPENG_CWD;
  if (!parentAgentRunId || !cwd) {
    throw new Error(
      "mcp-subagent server missing required LOOPENG_PARENT_AGENT_RUN_ID / LOOPENG_CWD env vars — was it launched outside buildSubAgentMcpConfig?",
    );
  }
  const disallowedTools = process.env.LOOPENG_DISALLOWED_TOOLS?.split(",").filter(Boolean);
  return {
    parentAgentRunId,
    cwd,
    cardId: process.env.LOOPENG_CARD_ID || null,
    worktreeId: process.env.LOOPENG_WORKTREE_ID || null,
    depth: Number(process.env.LOOPENG_DELEGATION_DEPTH ?? "0"),
    disallowedTools: disallowedTools?.length ? disallowedTools : undefined,
  };
}

const server = new McpServer({ name: "loopeng-subagent", version: "0.1.0" });

server.registerTool(
  "spawn_sub_agent",
  {
    description:
      "Delegate a focused, self-contained task to a fresh sub-agent running in the same worktree. " +
      "Blocks until the sub-agent finishes and returns its final result text so you can continue " +
      "your own reasoning with it. Delegation depth is capped — attempting to exceed it returns an error.",
    inputSchema: {
      task: z.string().min(1).describe("The specific, self-contained task for the sub-agent to complete."),
      context: z.string().default("").describe("Relevant background/context the sub-agent needs to complete the task."),
    },
  },
  async ({ task, context }) => {
    try {
      const ctx = readEnvContext();
      const result = await spawnSubAgent({
        parentAgentRunId: ctx.parentAgentRunId,
        cardId: ctx.cardId,
        worktreeId: ctx.worktreeId,
        cwd: ctx.cwd,
        depth: ctx.depth,
        disallowedTools: ctx.disallowedTools,
        task,
        context: context ?? "",
      });
      return {
        isError: result.isError,
        content: [{ type: "text" as const, text: result.resultText }],
      };
    } catch (err) {
      if (err instanceof SubAgentDepthExceededError) {
        return { isError: true, content: [{ type: "text" as const, text: err.message }] };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `spawn_sub_agent failed: ${message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
