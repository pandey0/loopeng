import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, db, pool, projects } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPlugin } from "../plugins/auth.js";
import { errorHandlerPlugin } from "../plugins/error-handler.js";
import { authHeaderFor } from "../test-helpers/auth.js";
import { projectRoutes } from "./projects.js";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof db;
  }
}

describe("POST /projects", () => {
  let app: FastifyInstance;
  let validRepoPath: string;
  let humanHeader: { Authorization: string };
  const createdProjectIds: string[] = [];
  const createdBoardIds: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.decorate("db", db);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await app.register(projectRoutes);

    validRepoPath = await mkdtemp(path.join(tmpdir(), "projects-route-test-"));
    const git = simpleGit(validRepoPath);
    await git.init();
    humanHeader = await authHeaderFor("user");
  });

  afterAll(async () => {
    for (const id of createdBoardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of createdProjectIds) await db.delete(projects).where(eq(projects.id, id));
    await rm(validRepoPath, { recursive: true, force: true });
    await app.close();
    await pool.end();
  });

  it("rejects a repo path that isn't a git repository with a clear, immediate error", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "projects-route-test-not-a-repo-"));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/projects",
        headers: humanHeader,
        payload: { name: "Bad Project", repoPath: notARepo },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe("invalid_repo");
      expect(body.message).toMatch(/not a git repository/);

      const rows = await db.select().from(projects).where(eq(projects.name, "Bad Project"));
      expect(rows).toHaveLength(0);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it("rejects a repo path that doesn't exist at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      headers: humanHeader,
      payload: { name: "Nonexistent Project", repoPath: "/definitely/does/not/exist/anywhere" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_repo");
  });

  it("registers a project with a valid git repo and creates a board scoped to it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      headers: humanHeader,
      payload: { name: "Good Project", repoPath: validRepoPath },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { project: { id: string; repoPath: string }; board: { id: string; projectId: string | null } };
    createdProjectIds.push(body.project.id);
    createdBoardIds.push(body.board.id);

    expect(body.project.repoPath).toBe(validRepoPath);
    expect(body.board.projectId).toBe(body.project.id);

    const [boardRow] = await db.select().from(boards).where(eq(boards.id, body.board.id));
    expect(boardRow?.projectId).toBe(body.project.id);
  });

  it("401s an unauthenticated create, and creates nothing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Unauthenticated Project", repoPath: validRepoPath },
    });
    expect(response.statusCode).toBe(401);
    const rows = await db.select().from(projects).where(eq(projects.name, "Unauthenticated Project"));
    expect(rows).toHaveLength(0);
  });

  it("403s an agent-scoped caller trying to create a project -- only a verified human may", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      headers: agentHeader,
      payload: { name: "Agent-created Project", repoPath: validRepoPath },
    });
    expect(response.statusCode).toBe(403);
    const rows = await db.select().from(projects).where(eq(projects.name, "Agent-created Project"));
    expect(rows).toHaveLength(0);
  });

  it("401s an unauthenticated reanalyze call", async () => {
    const response = await app.inject({ method: "POST", url: "/projects/00000000-0000-0000-0000-000000000000/reanalyze" });
    expect(response.statusCode).toBe(401);
  });

  it("403s an agent-scoped caller's reanalyze call", async () => {
    const agentHeader = await authHeaderFor("agent", "00000000-0000-0000-0000-0000000000ff");
    const response = await app.inject({
      method: "POST",
      url: "/projects/00000000-0000-0000-0000-000000000000/reanalyze",
      headers: agentHeader,
    });
    expect(response.statusCode).toBe(403);
  });
});
