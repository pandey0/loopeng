import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, docs, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { docRoutes } from "./docs.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

// Card 438646e5's follow-up scope: doc creation/versioning is human-only
// (requireHumanActor) -- same trust boundary as boards/projects.
describe("POST /docs and /docs/:slug/versions: human-only", () => {
  let app: FastifyInstance;
  const createdSlugs: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(docRoutes);
  });

  afterAll(async () => {
    for (const slug of createdSlugs) await db.delete(docs).where(eq(docs.slug, slug));
    await app.close();
    await pool.end();
  });

  const docPayload = (slug: string) => ({
    slug,
    title: "auth test doc",
    docType: "wiki",
    content: "content",
    summary: "summary",
  });

  it("401s an unauthenticated doc creation, and creates nothing", async () => {
    const response = await app.inject({ method: "POST", url: "/docs", payload: docPayload("docs-auth-unauth") });
    expect(response.statusCode).toBe(401);
    const rows = await db.select().from(docs).where(eq(docs.slug, "docs-auth-unauth"));
    expect(rows).toHaveLength(0);
  });

  it("403s an agent-scoped caller creating a doc, and creates nothing", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const response = await app.inject({ method: "POST", url: "/docs", headers: agentHeader, payload: docPayload("docs-auth-agent") });
    expect(response.statusCode).toBe(403);
    const rows = await db.select().from(docs).where(eq(docs.slug, "docs-auth-agent"));
    expect(rows).toHaveLength(0);
  });

  it("201s a verified human caller creating a doc", async () => {
    const humanHeader = await authHeaderFor("user");
    const response = await app.inject({ method: "POST", url: "/docs", headers: humanHeader, payload: docPayload("docs-auth-human") });
    expect(response.statusCode).toBe(201);
    createdSlugs.push("docs-auth-human");
  });

  it("401s an unauthenticated new-version post on an existing doc", async () => {
    const humanHeader = await authHeaderFor("user");
    await app.inject({ method: "POST", url: "/docs", headers: humanHeader, payload: docPayload("docs-auth-versions") });
    createdSlugs.push("docs-auth-versions");

    const response = await app.inject({
      method: "POST",
      url: "/docs/docs-auth-versions/versions",
      payload: { content: "updated content" },
    });
    expect(response.statusCode).toBe(401);
  });
});
