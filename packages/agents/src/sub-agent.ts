import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeCliStreaming, type StreamEvent } from "./claude-cli.js";
import { writeAgentLog } from "./logs.js";

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
  /**
   * Single-run-scoped API key (see runApiKeyEnv in roles.ts) minted for
   * parentAgentRunId -- the credential the sub-agent MCP server process
   * authenticates the API with. Never a raw DB connection string (card
   * 438646e5): this process used to get the loopeng_agent_runs role's
   * connection string under the DATABASE_URL name (migrations 0011/0012),
   * which had table-wide grants across every card's agent_runs rows, not
   * just this run's own -- and sat in cleartext in .env.example, reachable
   * by any agent worktree via a plain file read. Revoked outright
   * (migration 0013); spawnSubAgent below now creates/finishes runs over
   * POST /agent-runs the same way every other card mutation happens.
   */
  cardApiKey: string;
  cardApiUrl: string;
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
// back to this Node process — the server calls spawnSubAgent below, which
// talks to the API (never the database directly) to do its agent_runs
// bookkeeping and doc reads.
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
          // Card 438646e5: no DATABASE_URL of any kind reaches this process
          // (or any agent-worktree-reachable process) any more, scoped or
          // not -- a single-run-scoped API key instead, the same credential
          // class the top-level run itself gets (see runApiKeyEnv in
          // roles.ts). spawnSubAgent below creates and finishes agent_runs
          // rows, and get_doc reads docs, over this authenticated API
          // connection, exactly like every other card mutation.
          CARD_API_KEY: ctx.cardApiKey,
          CARD_API_URL: ctx.cardApiUrl,
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
  /** This MCP server process's own CARD_API_KEY/CARD_API_URL (see SubAgentContext) -- authenticates as parentAgentRunId. */
  cardApiKey: string;
  cardApiUrl: string;
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

// Card 438646e5: creates and finishes the sub-agent's agent_runs row over
// the authenticated API (never a direct DB connection) -- apiKey/apiUrl are
// this call's own CARD_API_KEY/CARD_API_URL (see buildSubAgentMcpConfig),
// scoped to parentAgentRunId by requireActor server-side, so the new run is
// always created under whatever card (or project/board, or neither) the
// caller's own run was already scoped to; there's no client-suppliable
// cardId/parentAgentRunId field for a caller to spoof.
async function createSubAgentRun(
  apiUrl: string,
  apiKey: string,
  worktreeId: string | null,
): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${apiUrl}/agent-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ worktreeId }),
  });
  if (!res.ok) {
    throw new Error(`spawn_sub_agent: failed to create agent run (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { id: string; apiKey: string };
}

async function finishSubAgentRun(
  apiUrl: string,
  runApiKey: string,
  runId: string,
  status: "succeeded" | "failed",
  logsRef: string,
): Promise<void> {
  const res = await fetch(`${apiUrl}/agent-runs/${runId}/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${runApiKey}` },
    body: JSON.stringify({ status, logsRef }),
  });
  if (!res.ok) {
    console.error(`spawn_sub_agent: failed to finish agent run ${runId} (${res.status}): ${await res.text()}`);
  }
}

// Called from inside the MCP server's spawn_sub_agent tool handler. Blocks
// until the sub-agent session fully finishes — that synchronous wait is what
// keeps this safe against concurrent writes to the shared worktree (see
// spec: MCP tool calls block the caller until they return).
export async function spawnSubAgent(input: SpawnSubAgentInput): Promise<SpawnSubAgentResult> {
  if (input.depth > MAX_DELEGATION_DEPTH) {
    throw new SubAgentDepthExceededError(input.depth);
  }
  if (!input.cardApiUrl || !input.cardApiKey) {
    throw new Error(
      "spawn_sub_agent: missing CARD_API_URL/CARD_API_KEY -- was this MCP server launched outside buildSubAgentMcpConfig?",
    );
  }

  const { id: runId, apiKey: runApiKey } = await createSubAgentRun(input.cardApiUrl, input.cardApiKey, input.worktreeId);

  // The sub-agent gets its own mcp-config too, one depth deeper, so it can
  // itself delegate further until MAX_DELEGATION_DEPTH is hit -- with its
  // own freshly-minted key, never its parent's.
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: runId,
    cardId: input.cardId,
    worktreeId: input.worktreeId,
    cwd: input.cwd,
    depth: input.depth + 1,
    disallowedTools: input.disallowedTools,
    cardApiKey: runApiKey,
    cardApiUrl: input.cardApiUrl,
  });

  const session = runClaudeCliStreaming({
    cwd: input.cwd,
    agentRunId: runId,
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

  const logsRef = await writeAgentLog(runId, events);

  const isError = timedOut || !finalResult ? true : Boolean(finalResult.is_error);
  const resultText = timedOut
    ? "sub-agent timed out waiting for a result event"
    : finalResult && typeof finalResult.result === "string"
      ? finalResult.result
      : "sub-agent produced no result event before exiting";

  await finishSubAgentRun(input.cardApiUrl, runApiKey, runId, isError ? "failed" : "succeeded", logsRef);

  return { agentRunId: runId, isError, resultText };
}
