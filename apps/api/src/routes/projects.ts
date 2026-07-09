import type { FastifyPluginAsync } from "fastify";
import { boards, projects } from "@loopeng/db";
import { ProjectCreateInputSchema } from "@loopeng/shared";
import { InvalidRepoError, isValidGitRepoRoot } from "@loopeng/worktree-manager";

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/projects", async () => {
    return fastify.db.select().from(projects);
  });

  // Validates the repo synchronously at registration time so a bad path
  // (typo, not-yet-cloned repo, missing .git) fails right here with a clear
  // error instead of silently stranding every card dispatched against it --
  // see resolveRepoRootForCard, which re-runs this same check on every
  // dispatch since the directory can go bad after registration too.
  fastify.post("/projects", async (request, reply) => {
    const input = ProjectCreateInputSchema.parse(request.body);
    if (!isValidGitRepoRoot(input.repoPath)) {
      reply.status(400).send({ error: "invalid_repo", message: new InvalidRepoError(input.repoPath).message });
      return;
    }

    const [project] = await fastify.db.insert(projects).values(input).returning();
    if (!project) throw new Error("failed to insert project row");

    // A project with no board to dispatch cards from is dead weight, so
    // registration creates its board in the same request -- it shows up as
    // a selectable board on /board immediately, no separate step.
    const [board] = await fastify.db
      .insert(boards)
      .values({ name: project.name, description: `Project board for ${project.name}`, projectId: project.id })
      .returning();
    if (!board) throw new Error("failed to insert board row");

    reply.status(201).send({ project, board });
  });
};
