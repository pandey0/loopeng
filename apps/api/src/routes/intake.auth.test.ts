import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { agentRuns, boards, db, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { intakeRoutes } from "./intake.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Card 438646e5's follow-up scope: starting a planning conversation and
// approving its output onto the board are human-only actions
// (requireHumanActor) -- neither has a single card to scope an agent
// credential to.
describe("POST /boards/:id/intake and .../approve: human-only", () => {
  let app: FastifyInstance;
  let boardId: string;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(intakeRoutes);

    const [board] = await db.insert(boards).values({ name: "intake-auth test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;
  });

  afterAll(async () => {
    await db.delete(agentRuns).where(eq(agentRuns.boardId, boardId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  it("401s an unauthenticated intake request, and starts no planner run", async () => {
    const before = await db.select().from(agentRuns).where(eq(agentRuns.boardId, boardId));
    const response = await app.inject({
      method: "POST",
      url: `/boards/${boardId}/intake`,
      payload: { requestText: "build something" },
    });
    expect(response.statusCode).toBe(401);
    const after = await db.select().from(agentRuns).where(eq(agentRuns.boardId, boardId));
    expect(after).toHaveLength(before.length);
  });

  it("403s an agent-scoped caller starting intake, and starts no planner run", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const before = await db.select().from(agentRuns).where(eq(agentRuns.boardId, boardId));
    const response = await app.inject({
      method: "POST",
      url: `/boards/${boardId}/intake`,
      headers: agentHeader,
      payload: { requestText: "build something" },
    });
    expect(response.statusCode).toBe(403);
    const after = await db.select().from(agentRuns).where(eq(agentRuns.boardId, boardId));
    expect(after).toHaveLength(before.length);
  });

  it("401s an unauthenticated approve call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/boards/${boardId}/intake/00000000-0000-0000-0000-000000000000/approve`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("403s an agent-scoped caller's approve call", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const response = await app.inject({
      method: "POST",
      url: `/boards/${boardId}/intake/00000000-0000-0000-0000-000000000000/approve`,
      headers: agentHeader,
    });
    expect(response.statusCode).toBe(403);
  });
});
