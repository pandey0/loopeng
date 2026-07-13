import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cards, db, gateDefinitions, gateResults, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployRoutes } from "./deploys.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

describe("GET /deploys", () => {
  let app: FastifyInstance;
  let boardId: string;
  let cardId: string;
  let deployLiveGateDefId: string;
  const gateResultIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(deployRoutes);

    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "deploy_live"));
    if (!gateDef) throw new Error("deploy_live gate_definition not seeded -- run `pnpm --filter @loopeng/db seed` first");
    deployLiveGateDefId = gateDef.id;

    const [board] = await db.insert(boards).values({ name: "deploys route test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [card] = await db
      .insert(cards)
      .values({ boardId, title: "deploys route test card" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cardId = card.id;

    // Real dev/CI data already has many deploy_live gate_results rows, so
    // these need timestamps newer than anything already in the table (not
    // just newer than each other) to land within the default-limited page.
    const now = Date.now();
    const rows = await db
      .insert(gateResults)
      .values([
        {
          cardId,
          gateDefinitionId: deployLiveGateDefId,
          status: "failed",
          detail: { reason: "health check timed out" },
          createdAt: new Date(now + 1000),
        },
        {
          cardId,
          gateDefinitionId: deployLiveGateDefId,
          status: "passed",
          detail: { deployUrl: "https://example.test" },
          createdAt: new Date(now + 2000),
        },
      ])
      .returning({ id: gateResults.id });
    gateResultIds.push(...rows.map((r) => r.id));
  });

  afterAll(async () => {
    for (const id of gateResultIds) await db.delete(gateResults).where(eq(gateResults.id, id));
    await db.delete(cards).where(eq(cards.id, cardId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await app.close();
    await pool.end();
  });

  it("returns deploy_live gate_results newest first, joined to card and board", async () => {
    const response = await app.inject({ method: "GET", url: "/deploys" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      id: string;
      status: string;
      detail: Record<string, unknown>;
      createdAt: string;
      card: { id: string; title: string };
      board: { id: string; name: string } | null;
    }[];

    const ours = body.filter((row) => row.card.id === cardId);
    expect(ours).toHaveLength(2);
    expect(ours[0]).toMatchObject({ status: "passed", card: { id: cardId, title: "deploys route test card" }, board: { id: boardId } });
    expect(ours[1]).toMatchObject({ status: "failed", detail: { reason: "health check timed out" } });
  });

  it("excludes gate_results for gates other than deploy_live", async () => {
    const [otherGateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "tests_ci"));
    if (!otherGateDef) return;

    const [otherRow] = await db
      .insert(gateResults)
      .values({ cardId, gateDefinitionId: otherGateDef.id, status: "passed" })
      .returning({ id: gateResults.id });
    if (!otherRow) throw new Error("gate result insert returned no row");

    try {
      const response = await app.inject({ method: "GET", url: "/deploys" });
      const body = response.json() as { id: string }[];
      expect(body.some((row) => row.id === otherRow.id)).toBe(false);
    } finally {
      await db.delete(gateResults).where(eq(gateResults.id, otherRow.id));
    }
  });

  it("respects the limit query param", async () => {
    const response = await app.inject({ method: "GET", url: "/deploys?limit=1" });
    const body = response.json() as unknown[];
    expect(body).toHaveLength(1);
  });
});
