import { spawn } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { agentRuns, db } from "@loopeng/db";

export interface RunClaudeCliInput {
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxBudgetUsd?: number;
  /** MCP server config (e.g. sub-agent delegation), passed inline as JSON via --mcp-config. */
  mcpConfig?: Record<string, unknown>;
}

export interface ClaudeCliResult {
  resultText: string;
  isError: boolean;
  sessionId?: string;
  totalCostUsd?: number;
  raw: unknown;
}

// Shells out to the Claude Code CLI in headless/print mode rather than
// building a custom LLM-calling agent loop — the CLI already is a fully
// capable coding agent (read/edit/bash/tests). The orchestrator only owns
// process lifecycle + worktree cwd; the CLI owns the actual coding work.
export function runClaudeCli(input: RunClaudeCliInput): Promise<ClaudeCliResult> {
  const args = ["-p", input.prompt, "--output-format", "json"];
  args.push("--permission-mode", input.permissionMode ?? "acceptEdits");
  if (input.model) args.push("--model", input.model);
  if (input.allowedTools?.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.maxBudgetUsd) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  if (input.appendSystemPrompt) args.push("--append-system-prompt", input.appendSystemPrompt);
  if (input.mcpConfig) args.push("--mcp-config", JSON.stringify(input.mcpConfig));

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: input.cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => reject(new Error(`failed to spawn claude cli: ${err.message}`)));

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude cli exited ${code}: ${stderr || "no output"}`));
        return;
      }
      try {
        const raw = JSON.parse(stdout);
        resolve({
          resultText: typeof raw.result === "string" ? raw.result : stdout,
          isError: Boolean(raw.is_error) || code !== 0,
          sessionId: raw.session_id,
          totalCostUsd: raw.total_cost_usd,
          raw,
        });
      } catch {
        // non-JSON output (e.g. crash before first turn) — surface raw text, mark as error
        resolve({ resultText: stdout || stderr, isError: true, raw: { stdout, stderr, code } });
      }
    });
  });
}

// ===== Interactive streaming sessions =====
//
// Distinct from runClaudeCli above: this keeps stdin open for the lifetime of
// the child process so a caller (eventually the card-C WebSocket bridge) can
// push follow-up turns into a running agent instead of only firing one prompt
// and reading one result. Every call site of the existing one-shot function
// is untouched; nothing switches to this yet (that migration is card C).

export type StreamEvent = Record<string, unknown>;

export type StreamEventHandler = (event: StreamEvent) => void;

export interface RunClaudeCliStreamingInput {
  cwd: string;
  agentRunId: string;
  prompt: string;
  appendSystemPrompt?: string;
  permissionMode?: RunClaudeCliInput["permissionMode"];
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  mcpConfig?: Record<string, unknown>;
}

export interface StreamingSession {
  agentRunId: string;
  /** Registers a handler for every parsed stream-json event. Returns an unsubscribe function. */
  onEvent(handler: StreamEventHandler): () => void;
  /** Writes a new user-turn stream-json message to the child's stdin, and records it in the transcript as a human-originated event. */
  sendInput(text: string): void;
  /** Ends the session: closes stdin and terminates the child process. */
  close(): void;
  /** Resolves once the child process has exited. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /**
   * Snapshot of every event observed so far, in arrival order. Backed by an
   * in-memory array (not a DB read) so a WebSocket connection can grab a
   * replay snapshot and subscribe to onEvent back-to-back with no async gap
   * between them -- Node's single-threaded execution guarantees no event can
   * be missed or duplicated across that handoff.
   */
  getTranscript(): StreamEvent[];
}

function formatUserTurn(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

// Appends onto agent_runs.transcript rather than overwriting it, so every
// event observed for this run accumulates in arrival order. Updates are
// chained onto a per-session queue (not fired concurrently) because
// concurrent UPDATEs racing on the same jsonb array could interleave out of
// arrival order.
function makeTranscriptAppender(agentRunId: string) {
  let queue: Promise<unknown> = Promise.resolve();
  return (event: StreamEvent) => {
    queue = queue
      .then(() =>
        db
          .update(agentRuns)
          .set({ transcript: sql`${agentRuns.transcript} || ${JSON.stringify([event])}::jsonb` })
          .where(eq(agentRuns.id, agentRunId)),
      )
      .catch((err) => {
        console.error(`failed to persist transcript event for agent run ${agentRunId}:`, err);
      });
  };
}

export function runClaudeCliStreaming(input: RunClaudeCliStreamingInput): StreamingSession {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    input.permissionMode ?? "acceptEdits",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.allowedTools?.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.appendSystemPrompt) args.push("--append-system-prompt", input.appendSystemPrompt);
  if (input.mcpConfig) args.push("--mcp-config", JSON.stringify(input.mcpConfig));

  const child = spawn("claude", args, { cwd: input.cwd, env: process.env });

  const handlers = new Set<StreamEventHandler>();
  const appendTranscript = makeTranscriptAppender(input.agentRunId);
  const transcript: StreamEvent[] = [];
  let buffer = "";

  function emit(event: StreamEvent): void {
    transcript.push(event);
    appendTranscript(event);
    for (const handler of handlers) handler(event);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue; // ignore non-JSON stdout noise
      }
      emit(event);
    }
  });

  child.on("error", (err) => {
    console.error(`failed to spawn claude cli (streaming) for agent run ${input.agentRunId}:`, err);
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      sessionRegistry.unregister(input.agentRunId);
      resolve({ code, signal });
    });
  });

  child.stdin.write(formatUserTurn(input.prompt) + "\n");

  const session: StreamingSession = {
    agentRunId: input.agentRunId,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    sendInput(text) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write(formatUserTurn(text) + "\n");
      // The child's stdout never echoes back what we wrote to its stdin, so
      // this is the only place a human-relayed turn (card C's WebSocket input
      // relay) becomes visible to subscribers/playback. actor_type marks it
      // as human-originated, distinct from undecorated agent/system events.
      emit({ type: "user", actor_type: "human", message: { role: "user", content: [{ type: "text", text }] } });
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed if the process exited
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
    waitForExit() {
      return exitPromise;
    },
    getTranscript() {
      return [...transcript];
    },
  };

  sessionRegistry.register(input.agentRunId, session);
  return session;
}

// Drives a streaming session through exactly one turn and returns a result
// shaped like the one-shot runClaudeCli's, so callers (the roles below) can
// switch transport without changing how they parse the outcome. The session
// stays registered -- and so reachable by a card-C WebSocket connection for
// live viewing and mid-turn input -- from spawn until the turn's "result"
// event lands, at which point it's closed and the child is torn down, same
// lifetime as the one-shot CLI call it replaces.
export async function runClaudeCliStreamingOnce(input: RunClaudeCliStreamingInput): Promise<ClaudeCliResult> {
  const session = runClaudeCliStreaming(input);
  try {
    const resultEvent = await new Promise<StreamEvent>((resolve, reject) => {
      const unsubscribe = session.onEvent((event) => {
        if (event.type === "result") {
          unsubscribe();
          resolve(event);
        }
      });
      session.waitForExit().then(({ code, signal }) => {
        unsubscribe();
        reject(new Error(`claude cli (streaming) exited before emitting a result event (code=${code}, signal=${signal})`));
      });
    });
    return {
      resultText: typeof resultEvent.result === "string" ? resultEvent.result : JSON.stringify(resultEvent),
      isError: Boolean(resultEvent.is_error),
      sessionId: typeof resultEvent.session_id === "string" ? resultEvent.session_id : undefined,
      totalCostUsd: typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : undefined,
      raw: resultEvent,
    };
  } catch (err) {
    return { resultText: err instanceof Error ? err.message : String(err), isError: true, raw: { error: String(err) } };
  } finally {
    session.close();
    await session.waitForExit();
  }
}

// ===== Session registry =====
//
// Process-local (in-memory, single-node) map of live streaming sessions so a
// later WebSocket connection (card C) can find and attach to an in-flight
// session by agent_runs id. This platform is self-hosted/single-tenant
// (Phase 1 architecture) so a single-process Map is sufficient — no
// distributed state needed.
class SessionRegistry {
  private sessions = new Map<string, StreamingSession>();

  register(agentRunId: string, session: StreamingSession): void {
    this.sessions.set(agentRunId, session);
  }

  unregister(agentRunId: string): void {
    this.sessions.delete(agentRunId);
  }

  get(agentRunId: string): StreamingSession | undefined {
    return this.sessions.get(agentRunId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }
}

export const sessionRegistry = new SessionRegistry();
