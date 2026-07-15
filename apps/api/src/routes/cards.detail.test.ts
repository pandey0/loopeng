import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { agentRoles, agentRuns, boards, cards, db, pool } from "@loopeng/db";
import { sessionRegistry, type StreamingSession } from "@loopeng/agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { cardRoutes } from "./cards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Just enough of a StreamingSession to occupy a sessionRegistry slot — the
// detail route only checks presence (sessionRegistry.get !== undefined), it
// never calls into the session.
function makeStubSession(agentRunId: string): StreamingSession {
  return {
    agentRunId,
    onEvent: () => () => {},
    sendInput: () => {},
    close: () => {},
    waitForExit: () => new Promise(() => {}),
    getTranscript: () => [],
  };
}

describe("GET /cards/:id/detail agent runs", () => {
  let app: FastifyInstance;
  let boardId: string;
  let cardId: string;
  let parentRunId: string;
  let childRunId: string;
  let roleId: string;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(authPlugin);
    await app.register(cardRoutes);

    const [board] = await db.insert(boards).values({ name: "card-d detail test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [card] = await db
      .insert(cards)
      .values({ boardId, title: "card-d detail test card" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cardId = card.id;

    const [role] = await db
      .insert(agentRoles)
      .values({ name: "implementer (card-d test)" })
      .returning({ id: agentRoles.id });
    if (!role) throw new Error("role insert returned no row");
    roleId = role.id;

    const [parentRun] = await db
      .insert(agentRuns)
      .values({ cardId, agentRoleId: roleId, status: "running", startedAt: new Date("2026-07-01T00:00:00Z") })
      .returning({ id: agentRuns.id });
    if (!parentRun) throw new Error("parent run insert returned no row");
    parentRunId = parentRun.id;

    const [childRun] = await db
      .insert(agentRuns)
      .values({
        cardId,
        parentAgentRunId: parentRunId,
        status: "succeeded",
        verdict: "pass",
        startedAt: new Date("2026-07-01T00:05:00Z"),
      })
      .returning({ id: agentRuns.id });
    if (!childRun) throw new Error("child run insert returned no row");
    childRunId = childRun.id;
  });

  afterAll(async () => {
    sessionRegistry.unregister(parentRunId);
    // agent_runs cascade with the card; the child references the parent so it goes first.
    await db.delete(agentRuns).where(eq(agentRuns.id, childRunId));
    await db.delete(agentRuns).where(eq(agentRuns.id, parentRunId));
    await db.delete(cards).where(eq(cards.id, cardId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await db.delete(agentRoles).where(eq(agentRoles.id, roleId));
    await app.close();
    await pool.end();
  });

  it("exposes parentAgentRunId and per-run live status derived from the session registry", async () => {
    sessionRegistry.register(parentRunId, makeStubSession(parentRunId));
    try {
      const response = await app.inject({ method: "GET", url: `/cards/${cardId}/detail` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { agentRuns: { id: string; parentAgentRunId: string | null; live: boolean }[] };

      const parent = body.agentRuns.find((run) => run.id === parentRunId);
      const child = body.agentRuns.find((run) => run.id === childRunId);
      expect(parent).toMatchObject({ parentAgentRunId: null, live: true });
      expect(child).toMatchObject({ parentAgentRunId: parentRunId, live: false });
    } finally {
      sessionRegistry.unregister(parentRunId);
    }
  });

  it("marks every run not-live once no session is registered", async () => {
    const response = await app.inject({ method: "GET", url: `/cards/${cardId}/detail` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { agentRuns: { live: boolean }[] };
    expect(body.agentRuns.every((run) => run.live === false)).toBe(true);
  });
});
