import Fastify, { type FastifyInstance } from "fastify";
import { db } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOT_ID, BOOTED_AT } from "../boot-info.js";
import { healthRoutes } from "./health.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// The deploy pipeline's native-api restart step (packages/deploy-engine/src
// /native-api.ts) polls this exact bootId/bootedAt shape to tell "a new
// process restarted" apart from "the same stale process is still up and
// happens to pass a DB-connectivity check" -- card 6d4dc01a.
describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(healthRoutes);
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports ok with a stable per-process bootId and bootedAt", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.bootId).toBe(BOOT_ID);
    expect(body.bootedAt).toBe(BOOTED_AT);
    expect(typeof body.pid).toBe("number");
  });

  it("returns the same bootId across repeated requests within one process", async () => {
    const first = (await app.inject({ method: "GET", url: "/health" })).json();
    const second = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(first.bootId).toBe(second.bootId);
  });
});
