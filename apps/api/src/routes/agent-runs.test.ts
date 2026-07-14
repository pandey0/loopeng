import Fastify, { type FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { agentRuns, boards, cards, db, eventLog, pool } from "@loopeng/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { agentRunRoutes } from "./agent-runs.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Regression test for card 438646e5: the sub-agent MCP server process
// (spawned inside an agent's own worktree) used to book-keep agent_runs
// directly against Postgres with a role whose grants spanned every card's
// run history, not just the caller's own, and left zero trace in
// event_log. These routes replace that entirely (migration 0013 revokes the
// role) -- spawn_sub_agent/get_doc now go through here, authenticated and
// scoped exactly like any other card mutation. This confirms: a sub-agent
// run is always created under whatever card the caller's own run was
// already scoped to (never a client-suppliable value), a run can only ever
// finish itself, and both actions land in event_log with a verifiable actor.
describe("POST /agent-runs and /agent-runs/:runId/finish", () => {
  let app: FastifyInstance;
  let boardId: string;
  let cardId: string;
  let parentRunId: string;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(agentRunRoutes);

    const [board] = await db.insert(boards).values({ name: "agent-runs test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [card] = await db.insert(cards).values({ boardId, title: "agent-runs test card", state: "in_progress" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cardId = card.id;

    const [parent] = await db.insert(agentRuns).values({ cardId, status: "running" }).returning({ id: agentRuns.id });
    if (!parent) throw new Error("agent run insert returned no row");
    parentRunId = parent.id;
    createdRunIds.push(parentRunId);
  });

  afterEach(async () => {
    await db.delete(eventLog).where(and(eq(eventLog.eventType, "agent_run.delegated")));
    await db.delete(eventLog).where(and(eq(eventLog.eventType, "agent_run.completed")));
  });

  afterAll(async () => {
    // Children (inserted after the parent) must be deleted first -- their
    // parent_agent_run_id FK would otherwise block deleting the parent row.
    for (const id of [...createdRunIds].reverse()) await db.delete(agentRuns).where(eq(agentRuns.id, id));
    await db.delete(cards).where(eq(cards.id, cardId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  it("401s a caller with no verified identity", async () => {
    const response = await app.inject({ method: "POST", url: "/agent-runs", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("403s a human (user) caller -- only an agent-scoped run can spawn a sub-agent run", async () => {
    const humanHeader = await authHeaderFor("user");
    const response = await app.inject({ method: "POST", url: "/agent-runs", headers: humanHeader, payload: {} });
    expect(response.statusCode).toBe(403);
  });

  it("creates a sub-agent run scoped to the caller's own card -- ignoring any cardId the body tries to supply", async () => {
    const agentHeader = await authHeaderFor("agent", parentRunId);

    const response = await app.inject({
      method: "POST",
      url: "/agent-runs",
      headers: agentHeader,
      // cardId here is not part of the schema at all -- proves a spoofed
      // value can't smuggle a sub-agent run onto an unrelated card.
      payload: { cardId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; apiKey: string };
    expect(body.id).toBeTruthy();
    expect(body.apiKey).toMatch(/^lk_/);
    createdRunIds.push(body.id);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, body.id));
    expect(run).toMatchObject({ cardId, parentAgentRunId: parentRunId, status: "running" });

    const [delegated] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, cardId), eq(eventLog.eventType, "agent_run.delegated")));
    expect(delegated).toMatchObject({ actorType: "agent", actorId: parentRunId, payload: { agentRunId: body.id } });
  });

  it("404s a caller whose own actor.id has no agent_runs row at all", async () => {
    const bogusHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-000000000000");
    const response = await app.inject({ method: "POST", url: "/agent-runs", headers: bogusHeader, payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it("lets a run finish itself, marks it audited, and revokes its own key so it can't be replayed", async () => {
    const agentHeader = await authHeaderFor("agent", parentRunId);
    const create = await app.inject({ method: "POST", url: "/agent-runs", headers: agentHeader, payload: {} });
    const { id: childId, apiKey: childApiKey } = create.json() as { id: string; apiKey: string };
    createdRunIds.push(childId);

    const finish = await app.inject({
      method: "POST",
      url: `/agent-runs/${childId}/finish`,
      headers: { Authorization: `Bearer ${childApiKey}` },
      payload: { status: "succeeded", logsRef: "/tmp/logs/x.json" },
    });
    expect(finish.statusCode).toBe(204);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, childId));
    expect(run?.status).toBe("succeeded");
    expect(run?.logsRef).toBe("/tmp/logs/x.json");
    expect(run?.finishedAt).not.toBeNull();

    const [completed] = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityId, cardId), eq(eventLog.eventType, "agent_run.completed")));
    expect(completed).toMatchObject({ actorType: "agent", actorId: childId, payload: { status: "succeeded" } });

    // The now-revoked key can't be used again for anything.
    const replay = await app.inject({
      method: "POST",
      url: `/agent-runs/${childId}/finish`,
      headers: { Authorization: `Bearer ${childApiKey}` },
      payload: { status: "failed" },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("403s a run trying to finish a run that isn't itself -- not even its own parent", async () => {
    const agentHeader = await authHeaderFor("agent", parentRunId);
    const create = await app.inject({ method: "POST", url: "/agent-runs", headers: agentHeader, payload: {} });
    const { id: childId } = create.json() as { id: string; apiKey: string };
    createdRunIds.push(childId);

    // The parent tries to close out its own child's run using the parent's key.
    const response = await app.inject({
      method: "POST",
      url: `/agent-runs/${childId}/finish`,
      headers: agentHeader,
      payload: { status: "succeeded" },
    });
    expect(response.statusCode).toBe(403);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, childId));
    expect(run?.status).toBe("running");
  });
});
