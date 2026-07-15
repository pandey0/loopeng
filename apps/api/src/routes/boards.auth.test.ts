import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, db, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { boardRoutes } from "./boards.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Card 438646e5's follow-up scope: board creation has no single card to
// scope an agent credential to, so it's human-only (requireHumanActor).
describe("POST /boards: human-only", () => {
  let app: FastifyInstance;
  const createdBoardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(boardRoutes);
  });

  afterAll(async () => {
    for (const id of createdBoardIds) await db.delete(boards).where(eq(boards.id, id));
    await app.close();
    await pool.end();
  });

  it("401s an unauthenticated create, and creates nothing", async () => {
    const response = await app.inject({ method: "POST", url: "/boards", payload: { name: "unauth board" } });
    expect(response.statusCode).toBe(401);
    const rows = await db.select().from(boards).where(eq(boards.name, "unauth board"));
    expect(rows).toHaveLength(0);
  });

  it("403s an agent-scoped caller, and creates nothing", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const response = await app.inject({ method: "POST", url: "/boards", headers: agentHeader, payload: { name: "agent board" } });
    expect(response.statusCode).toBe(403);
    const rows = await db.select().from(boards).where(eq(boards.name, "agent board"));
    expect(rows).toHaveLength(0);
  });

  it("201s a verified human caller", async () => {
    const humanHeader = await authHeaderFor("user");
    const response = await app.inject({ method: "POST", url: "/boards", headers: humanHeader, payload: { name: "human board" } });
    expect(response.statusCode).toBe(201);
    const board = response.json() as { id: string };
    createdBoardIds.push(board.id);
  });
});
