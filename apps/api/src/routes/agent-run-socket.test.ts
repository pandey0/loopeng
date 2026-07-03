import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { eq } from "drizzle-orm";
import { agentRuns, db, pool } from "@loopeng/db";
import { runClaudeCliStreaming, sessionRegistry, type StreamEvent, type StreamingSession } from "@loopeng/agents";
import { WebSocket } from "ws";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { agentRunSocketRoutes } from "./agent-run-socket.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// A real listening server + real `ws` clients, not @fastify/websocket's
// injectWS test helper: injectWS pairs the connection over in-process
// duplex streams and detects the "101 Switching Protocols" handshake by
// string search, dropping any bytes that land in the same chunk as that
// handshake -- which silently eats a server message sent synchronously on
// connect (exactly what the replay-on-connect behavior below does). A real
// socket doesn't have that failure mode, so this test binds an ephemeral
// port instead of using injectWS.
async function buildApp(): Promise<{ app: FastifyInstance; url: string }> {
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(websocketPlugin);
  await fastify.register(agentRunSocketRoutes);
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { app: fastify, url: `ws://127.0.0.1:${address.port}` };
}

// A stand-in for a real StreamingSession (which shells out to the claude CLI)
// so the WebSocket routing/broadcast logic can be tested deterministically
// and without a live process. Card A's own tests already cover sendInput
// actually reaching the child process; this fakes that boundary.
function makeFakeSession(agentRunId: string, initialTranscript: StreamEvent[] = []): StreamingSession & {
  emit: (event: StreamEvent) => void;
  resolveExit: () => void;
  sentInputs: string[];
} {
  const transcript = [...initialTranscript];
  const handlers = new Set<(event: StreamEvent) => void>();
  const sentInputs: string[] = [];
  let resolveExit!: () => void;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = () => resolve({ code: 0, signal: null });
  });

  return {
    agentRunId,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    sendInput(text) {
      sentInputs.push(text);
    },
    close() {},
    waitForExit() {
      return exitPromise;
    },
    getTranscript() {
      return [...transcript];
    },
    emit(event) {
      transcript.push(event);
      for (const handler of handlers) handler(event);
    },
    resolveExit() {
      resolveExit();
    },
    sentInputs,
  };
}

// Registers the "message" listener synchronously, before awaiting "open" --
// a server that replays a transcript immediately on connect can deliver that
// first frame in the same tick as the client's "open" event, and ws is a
// plain EventEmitter (it drops emits with no listener attached, it doesn't
// buffer). Awaiting "open" first and attaching "message" afterwards races
// against that same-tick delivery and can silently miss the replay.
function connect(url: string, id: string): Promise<{ ws: WebSocket; messages: StreamEvent[] }> {
  const ws = new WebSocket(`${url}/agent-runs/${id}/socket`);
  const messages: StreamEvent[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

function waitForCount(messages: unknown[], count: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (messages.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${count} messages, got ${messages.length}`));
      setTimeout(check, 10);
    };
    check();
  });
}

// Polls `messages` (mutated in place by the `connect()` "message" listener)
// for an event matching `predicate`, starting from index `fromIndex`. Used
// instead of a fixed waitForCount because the streaming CLI's event ordering
// (partial-message deltas, etc.) around a given result/echo isn't fixed.
function waitForEvent(
  messages: StreamEvent[],
  predicate: (event: StreamEvent, index: number) => boolean,
  timeoutMs = 2000,
  fromIndex = 0,
): Promise<StreamEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      for (let i = fromIndex; i < messages.length; i++) {
        const event = messages[i];
        if (event && predicate(event, i)) return resolve(event);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for matching event, got ${messages.length} messages`));
      setTimeout(check, 25);
    };
    check();
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for socket close")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("agent-run-socket route", () => {
  const createdRunIds: string[] = [];

  afterEach(async () => {
    while (createdRunIds.length) {
      const id = createdRunIds.pop();
      if (!id) continue;
      sessionRegistry.unregister(id);
      await db.delete(agentRuns).where(eq(agentRuns.id, id));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("replays the transcript then streams live events to two simultaneous subscribers", async () => {
    const inserted = await db.insert(agentRuns).values({ status: "running" }).returning({ id: agentRuns.id });
    const run = inserted[0];
    if (!run) throw new Error("insert did not return a row");
    createdRunIds.push(run.id);

    const replayEvent: StreamEvent = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello so far" }] } };
    const session = makeFakeSession(run.id, [replayEvent]);
    sessionRegistry.register(run.id, session);

    const { app, url } = await buildApp();
    try {
      const { ws: wsA, messages: messagesA } = await connect(url, run.id);
      const { ws: wsB, messages: messagesB } = await connect(url, run.id);

      // Both clients see the pre-connect transcript replayed immediately.
      await waitForCount(messagesA, 1);
      await waitForCount(messagesB, 1);
      expect(messagesA[0]).toEqual(replayEvent);
      expect(messagesB[0]).toEqual(replayEvent);

      // A live event emitted after both are connected reaches both identically.
      const liveEvent: StreamEvent = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "live update" }] } };
      session.emit(liveEvent);
      await waitForCount(messagesA, 2);
      await waitForCount(messagesB, 2);
      expect(messagesA[1]).toEqual(liveEvent);
      expect(messagesB[1]).toEqual(liveEvent);

      // Input sent from one client is relayed to the session's stdin.
      wsA.send(JSON.stringify({ type: "input", text: "steer the agent" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(session.sentInputs).toEqual(["steer the agent"]);

      wsA.close();
      wsB.close();
    } finally {
      session.resolveExit();
      await app.close();
    }
  });

  it("closes with 4004 and streams nothing for an unknown agent_runs id", async () => {
    const { app, url } = await buildApp();
    try {
      const { ws, messages } = await connect(url, randomUUID());
      const closeCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for socket close")), 2000);
        ws.once("close", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(closeCode).toBe(4004);
      expect(messages).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("streams the persisted transcript once and closes for a completed run, accepting no input", async () => {
    const persistedTranscript: StreamEvent[] = [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "result", result: "done", is_error: false },
    ];
    const inserted = await db
      .insert(agentRuns)
      .values({ status: "succeeded", transcript: persistedTranscript })
      .returning({ id: agentRuns.id });
    const run = inserted[0];
    if (!run) throw new Error("insert did not return a row");
    createdRunIds.push(run.id);

    expect(sessionRegistry.get(run.id)).toBeUndefined();

    const { app, url } = await buildApp();
    try {
      const { ws, messages } = await connect(url, run.id);

      await waitForCount(messages, persistedTranscript.length);
      expect(messages).toEqual(persistedTranscript);
      await waitForClose(ws);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await app.close();
    }
  });

  // Real (non-mocked) integration test: a real claude CLI child process,
  // registered in the actual sessionRegistry, reached only through the WS
  // route's socket.on("message") handler -- not by calling session.sendInput()
  // directly. Proves the WS input relay itself (JSON parse -> isInputMessage
  // -> session.sendInput) works against a live process, not just that
  // sendInput() works when called in-process (that's covered separately by
  // claude-cli.streaming.test.ts). Requires the `claude` CLI installed and
  // authenticated, same as that test.
  it(
    "relays input sent over the socket to a real claude CLI process and changes its next reply",
    async () => {
      const inserted = await db.insert(agentRuns).values({ status: "running" }).returning({ id: agentRuns.id });
      const run = inserted[0];
      if (!run) throw new Error("insert did not return a row");
      createdRunIds.push(run.id);

      const session = runClaudeCliStreaming({
        cwd: process.cwd(),
        agentRunId: run.id,
        prompt: 'Reply with exactly the word "ALPHA" and nothing else.',
        permissionMode: "bypassPermissions",
        model: "claude-haiku-4-5-20251001",
        disallowedTools: ["Bash", "Read", "Write", "Edit"],
      });
      expect(sessionRegistry.get(run.id)).toBe(session);

      const { app, url } = await buildApp();
      try {
        const { ws, messages } = await connect(url, run.id);

        // Wait for the first turn's result event (whether replayed-so-far or
        // streamed live -- the child may finish the first turn before or
        // after the socket connects).
        const firstResult = await waitForEvent(messages, (e) => e.type === "result", 30_000);
        expect(firstResult.is_error).toBeFalsy();
        expect(typeof firstResult.result === "string" ? firstResult.result : "").toContain("ALPHA");

        const beforeInputCount = messages.length;

        // The actual assertion: send input over the WebSocket wire, not by
        // calling session.sendInput() in-process.
        ws.send(JSON.stringify({ type: "input", text: 'Now reply with exactly the word "BRAVO" and nothing else.' }));

        // The relay must both (a) reach the CLI's stdin, changing its next
        // reply, and (b) echo the human-originated turn back to subscribers.
        const echoedInput = await waitForEvent(
          messages,
          (e) => e.type === "user" && e.actor_type === "human",
          20_000,
          beforeInputCount,
        );
        expect((echoedInput.message as { content: { text: string }[] }).content[0]?.text).toContain("BRAVO");

        const secondResult = await waitForEvent(messages, (e, i) => i >= beforeInputCount && e.type === "result", 30_000);
        expect(secondResult.is_error).toBeFalsy();
        expect(typeof secondResult.result === "string" ? secondResult.result : "").toContain("BRAVO");

        ws.close();
      } finally {
        session.close();
        await session.waitForExit();
        await app.close();
      }
    },
    60_000,
  );
});
