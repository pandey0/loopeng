import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { boards, cardDependencies, cards, db, pool, projects } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { projectRoutes } from "./projects.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

describe("GET /projects/:id/export", () => {
  let app: FastifyInstance;
  let projectId: string;
  let emptyProjectId: string;
  let boardId: string;
  let epicId: string;
  let featureId: string;

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(projectRoutes);

    const [project] = await db
      .insert(projects)
      .values({ name: "export test project", repoPath: "/tmp/export-test-project" })
      .returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    projectId = project.id;

    const [emptyProject] = await db
      .insert(projects)
      .values({ name: "export test empty project", repoPath: "/tmp/export-test-empty-project" })
      .returning({ id: projects.id });
    if (!emptyProject) throw new Error("empty project insert returned no row");
    emptyProjectId = emptyProject.id;

    const [board] = await db
      .insert(boards)
      .values({ name: "export test board", projectId })
      .returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [epic] = await db
      .insert(cards)
      .values({ boardId, title: "export test epic", cardType: "epic" })
      .returning({ id: cards.id });
    if (!epic) throw new Error("epic insert returned no row");
    epicId = epic.id;

    const [feature] = await db
      .insert(cards)
      .values({ boardId, title: "export test feature", cardType: "feature" })
      .returning({ id: cards.id });
    if (!feature) throw new Error("feature insert returned no row");
    featureId = feature.id;

    await db.insert(cardDependencies).values({ cardId: featureId, dependsOnCardId: epicId, dependencyType: "relates_to" });
  });

  afterAll(async () => {
    await db.delete(cardDependencies).where(eq(cardDependencies.cardId, featureId));
    await db.delete(cards).where(eq(cards.id, featureId));
    await db.delete(cards).where(eq(cards.id, epicId));
    await db.delete(boards).where(eq(boards.id, boardId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(projects).where(eq(projects.id, emptyProjectId));
    await app.close();
    await pool.end();
  });

  it("returns 404 with an error body for a nonexistent project", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/00000000-0000-0000-0000-000000000000/export" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
  });

  it("returns 200 with an empty cards array for a project with no boards/cards", async () => {
    const response = await app.inject({ method: "GET", url: `/projects/${emptyProjectId}/export` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    const body = response.json() as { schemaVersion: number; exportedAt: string; project: { id: string }; cards: unknown[] };
    expect(body.schemaVersion).toBe(1);
    expect(body.project.id).toBe(emptyProjectId);
    expect(body.cards).toEqual([]);
  });

  it("returns every card (including epics) across the project's boards, with epic linkage resolved", async () => {
    const response = await app.inject({ method: "GET", url: `/projects/${projectId}/export` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      schemaVersion: number;
      exportedAt: string;
      project: { id: string; name: string };
      cards: { id: string; cardType: string; epicId: string | null }[];
    };

    expect(body.schemaVersion).toBe(1);
    expect(new Date(body.exportedAt).toString()).not.toBe("Invalid Date");
    expect(body.project).toMatchObject({ id: projectId, name: "export test project" });
    expect(body.cards).toHaveLength(2);

    const epicCard = body.cards.find((c) => c.id === epicId);
    const featureCard = body.cards.find((c) => c.id === featureId);
    expect(epicCard).toMatchObject({ cardType: "epic", epicId: null });
    expect(featureCard).toMatchObject({ cardType: "feature", epicId });
  });
});
