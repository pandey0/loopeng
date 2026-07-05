import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { agentRuns, db } from "@loopeng/db";
import { runClaudeCliStreaming, type StreamEvent } from "./claude-cli.js";
import { writeAgentLog } from "./logs.js";
import { getRoleId } from "./roles.js";

// v1 hard cap on delegation depth (ADR 0002 scope decision: no cost/quota
// policy yet, just a structural guard against runaway recursive delegation).
// depth 0 = a top-level implementer/reviewer/planner run. A tool call from
// depth N creates a run at depth N+1; depth values above this are refused.
export const MAX_DELEGATION_DEPTH = 2;

export class SubAgentDepthExceededError extends Error {
  constructor(depth: number) {
    super(
      `sub-agent delegation depth ${depth} exceeds the max allowed depth of ${MAX_DELEGATION_DEPTH} — refusing to spawn another level to prevent runaway recursive delegation`,
    );
    this.name = "SubAgentDepthExceededError";
  }
}

export interface SubAgentContext {
  parentAgentRunId: string;
  cardId: string | null;
  worktreeId: string | null;
  cwd: string;
  /** Depth to assign to a sub-agent spawned from a CLI invocation carrying this context. */
  depth: number;
  /** Tool restrictions to mirror onto the spawned sub-agent (same shape as runClaudeCli's disallowedTools). */
  disallowedTools?: string[];
}

// The MCP server is a plain tsx-run script, not an importable package (importing
// it from here would create a circular workspace dependency: agents -> mcp-subagent
// -> agents). We only need its on-disk location to shell it out via --mcp-config.
//
// This is intentionally resolved from *this module's own* location (import.meta.url),
// not from the repo root / TARGET_REPO_PATH: every card runs in its own isolated
// worktree, so code that only exists in the current worktree (which, structurally,
// is every card until it merges) is unreachable via a shared "repo root" path — that
// path may be a different checkout entirely that predates this card's files. The
// running module is necessarily loaded from a worktree that has these files (it IS
// these files), so walking up from its own path always lands on the sibling
// mcp-subagent package in the same worktree/checkout that's actually executing.
function subAgentServerEntrypoint(): { command: string; args: string[] } {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // packages/agents/src -> packages/mcp-subagent
  const pkgDir = path.resolve(thisDir, "..", "..", "mcp-subagent");
  return {
    command: path.join(pkgDir, "node_modules", ".bin", "tsx"),
    args: [path.join(pkgDir, "src", "server.ts")],
  };
}

// Every field the sub-agent MCP server process needs is threaded through as
// plain env vars on its own (separate, tsx-spawned) process rather than IPC
// back to this Node process — the server has direct workspace access to
// @loopeng/db and @loopeng/agents so it can do the DB insert + streaming run
// itself instead of calling back into us.
export function buildSubAgentMcpConfig(ctx: SubAgentContext): Record<string, unknown> {
  const { command, args } = subAgentServerEntrypoint();
  return {
    mcpServers: {
      subagent: {
        command,
        args,
        env: {
          LOOPENG_PARENT_AGENT_RUN_ID: ctx.parentAgentRunId,
          LOOPENG_CARD_ID: ctx.cardId ?? "",
          LOOPENG_WORKTREE_ID: ctx.worktreeId ?? "",
          LOOPENG_CWD: ctx.cwd,
          LOOPENG_DELEGATION_DEPTH: String(ctx.depth),
          LOOPENG_DISALLOWED_TOOLS: (ctx.disallowedTools ?? []).join(","),
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          // The MCP server subprocess is spawned by the `claude` CLI itself
          // per --mcp-config, not by us directly — whether it inherits our
          // process.env (vs. only the keys listed here) isn't something we
          // control, so WIKI_REPO_PATH must be threaded through explicitly.
          // Without this, get_doc (packages/mcp-subagent/src/server.ts) can
          // silently resolve a different repo than the one this process is
          // using (its own cwd-relative default instead of ours), returning
          // ENOENT for docs that very much exist — just not at that path.
          ...(process.env.WIKI_REPO_PATH ? { WIKI_REPO_PATH: process.env.WIKI_REPO_PATH } : {}),
        },
      },
    },
  };
}

export interface SpawnSubAgentInput {
  parentAgentRunId: string;
  cardId: string | null;
  worktreeId: string | null;
  cwd: string;
  /** Depth being assigned to this sub-agent (root callers are depth 0; this is depth of the run being created). */
  depth: number;
  disallowedTools?: string[];
  task: string;
  context: string;
}

export interface SpawnSubAgentResult {
  agentRunId: string;
  isError: boolean;
  resultText: string;
}

function buildSubAgentPrompt(task: string, context: string): string {
  return [
    "You are a sub-agent delegated a focused task by a parent agent on an internal dev-team",
    "platform. You are working in the same git worktree the parent is using. Complete the task",
    "below and reply with a clear, self-contained final result — the parent agent only sees your",
    "final text response, not any of your intermediate steps.",
    "",
    "## Task",
    task,
    "",
    "## Context from the parent agent",
    context || "(none provided)",
  ].join("\n");
}

// Called from inside the MCP server's spawn_sub_agent tool handler. Blocks
// until the sub-agent session fully finishes — that synchronous wait is what
// keeps this safe against concurrent writes to the shared worktree (see
// spec: MCP tool calls block the caller until they return).
export async function spawnSubAgent(input: SpawnSubAgentInput): Promise<SpawnSubAgentResult> {
  if (input.depth > MAX_DELEGATION_DEPTH) {
    throw new SubAgentDepthExceededError(input.depth);
  }

  const roleId = await getRoleId("implementer");
  const [run] = await db
    .insert(agentRuns)
    .values({
      cardId: input.cardId,
      agentRoleId: roleId,
      worktreeId: input.worktreeId,
      parentAgentRunId: input.parentAgentRunId,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row for sub-agent");

  // The sub-agent gets its own mcp-config too, one depth deeper, so it can
  // itself delegate further until MAX_DELEGATION_DEPTH is hit.
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: input.cardId,
    worktreeId: input.worktreeId,
    cwd: input.cwd,
    depth: input.depth + 1,
    disallowedTools: input.disallowedTools,
  });

  const session = runClaudeCliStreaming({
    cwd: input.cwd,
    agentRunId: run.id,
    prompt: buildSubAgentPrompt(input.task, input.context),
    permissionMode: "bypassPermissions",
    disallowedTools: input.disallowedTools,
    mcpConfig,
  });

  const events: StreamEvent[] = [];
  let finalResult: StreamEvent | undefined;
  const unsubscribe = session.onEvent((event) => {
    events.push(event);
    if (event.type === "result") finalResult = event;
  });

  // The streaming CLI keeps its process alive after emitting a result, ready
  // to accept another turn on stdin (see runClaudeCliStreaming) — we only
  // ever want one turn here, so we must close the session ourselves or the
  // child (and this await) would hang forever. session.close() runs in
  // `finally` so a timed-out sub-agent still gets its process killed instead
  // of leaking, and the timeout itself is swallowed here (not rethrown) so
  // the run still gets recorded as failed below instead of left "running".
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("sub-agent session timed out waiting for a result event")),
        10 * 60_000,
      );
      const stop = session.onEvent((event) => {
        if (event.type === "result") {
          clearTimeout(timeout);
          stop();
          resolve();
        }
      });
    });
  } catch {
    timedOut = true;
  } finally {
    session.close();
    await session.waitForExit();
    unsubscribe();
  }

  const logsRef = await writeAgentLog(run.id, events);

  const isError = timedOut || !finalResult ? true : Boolean(finalResult.is_error);
  const resultText = timedOut
    ? "sub-agent timed out waiting for a result event"
    : finalResult && typeof finalResult.result === "string"
      ? finalResult.result
      : "sub-agent produced no result event before exiting";

  await db
    .update(agentRuns)
    .set({ status: isError ? "failed" : "succeeded", logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, run.id));

  return { agentRunId: run.id, isError, resultText };
}
