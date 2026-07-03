import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { eq } from "drizzle-orm";
import { agentRuns, db, pool } from "@loopeng/db";
import { sessionRegistry, type StreamEvent, type StreamingSession } from "@loopeng/agents";
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
});
