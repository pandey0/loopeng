import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { agentRuns } from "@loopeng/db";
import { sessionRegistry, type StreamEvent } from "@loopeng/agents";

interface InputMessage {
  type: "input";
  text: string;
}

function isInputMessage(value: unknown): value is InputMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "input" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function send(socket: { send: (data: string) => void }, event: StreamEvent): void {
  socket.send(JSON.stringify(event));
}

// GET /agent-runs/:id/socket -- WebSocket bridge onto a (possibly still
// running) agent run. A live run replays its transcript-so-far and then
// streams new events as they happen, and accepts input relayed to the
// underlying claude CLI process. A completed run streams its persisted
// transcript once, then closes -- there's no process left to send input to.
export const agentRunSocketRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/agent-runs/:id/socket", { websocket: true }, async (socket, request) => {
    const { id } = request.params as { id: string };

    const session = sessionRegistry.get(id);

    if (!session) {
      // No live session: this run either already finished or never existed.
      const [run] = await fastify.db.select({ transcript: agentRuns.transcript }).from(agentRuns).where(eq(agentRuns.id, id));
      if (!run) {
        // Unknown agent_runs id -- distinct from "finished with an empty
        // transcript" so a client can tell a bad id apart from a real,
        // still-empty run. 4004 mirrors HTTP 404 in the WS close-code space
        // (4000-4999 is the app-defined range per RFC 6455).
        socket.close(4004, "agent run not found");
        return;
      }
      // Playback-only: stream what's persisted and close.
      const transcript = (run.transcript as StreamEvent[] | undefined) ?? [];
      for (const event of transcript) send(socket, event);
      socket.close();
      return;
    }

    // Synchronous snapshot-then-subscribe with no await in between: no event
    // the child emits can land in the gap and be lost or double-sent (see
    // StreamingSession.getTranscript's doc comment in claude-cli.ts).
    const replay = session.getTranscript();
    for (const event of replay) send(socket, event);
    const unsubscribe = session.onEvent((event) => send(socket, event));

    let sessionEnded = false;
    session.waitForExit().then(() => {
      sessionEnded = true;
      socket.close();
    });

    socket.on("message", (raw: Buffer) => {
      if (sessionEnded) return; // run finished after connect -- no process left to steer
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (isInputMessage(parsed)) {
        session.sendInput(parsed.text);
      }
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });
};
