import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentRuns, db, pool } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { runClaudeCliStreaming, sessionRegistry, type StreamEvent } from "./claude-cli.js";

// Real (non-mocked) integration test: spawns the actual claude CLI in
// stream-json mode against a live agent_runs row. Requires the `claude` CLI
// to be installed and authenticated in this environment (same requirement
// as the existing one-shot runClaudeCli behavior it sits alongside).
describe("runClaudeCliStreaming", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("streams events, accepts mid-session input, and accumulates the transcript", async () => {
    const inserted = await db
      .insert(agentRuns)
      .values({ status: "running" })
      .returning({ id: agentRuns.id });
    const run = inserted[0];
    if (!run) throw new Error("insert did not return a row");
    const agentRunId = run.id;

    const events: StreamEvent[] = [];
    const session = runClaudeCliStreaming({
      cwd: process.cwd(),
      agentRunId,
      prompt: 'Reply with exactly the word "PONG" and nothing else.',
      permissionMode: "bypassPermissions",
      model: "claude-haiku-4-5-20251001",
      disallowedTools: ["Bash", "Read", "Write", "Edit"],
    });

    try {
      // The registry must resolve this run to the live session while it's running.
      expect(sessionRegistry.get(agentRunId)).toBe(session);

      const firstResult = await new Promise<StreamEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for first result event")), 60_000);
        const unsubscribe = session.onEvent((event) => {
          events.push(event);
          if (event.type === "result") {
            clearTimeout(timeout);
            unsubscribe();
            resolve(event);
          }
        });
      });
      expect(firstResult.is_error).toBeFalsy();
      expect(events.length).toBeGreaterThan(0);

      // Mid-session follow-up turn on the same still-open process.
      session.sendInput('Now reply with exactly the word "PONG2" and nothing else.');

      const secondResult = await new Promise<StreamEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for second result event")), 60_000);
        const unsubscribe = session.onEvent((event) => {
          events.push(event);
          if (event.type === "result") {
            clearTimeout(timeout);
            unsubscribe();
            resolve(event);
          }
        });
      });
      expect(secondResult.is_error).toBeFalsy();

      session.close();
      await session.waitForExit();

      // Session should be dropped from the registry once the child exits.
      expect(sessionRegistry.get(agentRunId)).toBeUndefined();

      // The transcript appender is async; give the last write a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId));
      const persisted = rows[0];
      if (!persisted) throw new Error("agent run row disappeared");
      const transcript = persisted.transcript as StreamEvent[];
      expect(Array.isArray(transcript)).toBe(true);
      expect(transcript.length).toBeGreaterThanOrEqual(events.length);
      expect(transcript.filter((event) => event.type === "result").length).toBeGreaterThanOrEqual(2);
    } finally {
      session.close();
      await db.delete(agentRuns).where(eq(agentRuns.id, agentRunId));
    }
  }, 120_000);
});
