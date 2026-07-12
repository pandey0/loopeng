import type { FastifyPluginAsync } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { agentRuns, boards, cardDependencies, cards, projects } from "@loopeng/db";
import { buildDependencyInfoMap } from "@loopeng/board-engine";
import { ProjectCreateInputSchema } from "@loopeng/shared";
import { runProjectAnalyzerAgent } from "@loopeng/agents";
import { cloneProjectRepo, InvalidRepoError, isValidGitRepoRoot, RepoCloneError } from "@loopeng/worktree-manager";

const EXPORT_SCHEMA_VERSION = 1;

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/projects", async () => {
    return fastify.db.select().from(projects);
  });

  // Validates the repo synchronously at registration time so a bad path
  // (typo, not-yet-cloned repo, missing .git) fails right here with a clear
  // error instead of silently stranding every card dispatched against it --
  // see resolveRepoRootForCard, which re-runs this same check on every
  // dispatch since the directory can go bad after registration too.
  //
  // Two onboarding paths, both land here: repoPath points at a repo already
  // on disk; repoUrl clones one fresh into a managed directory first (see
  // cloneProjectRepo). Either way, once repoPath resolves, registration
  // fires the analyzer agent in the background -- it's not awaited, so the
  // response comes back as soon as the project+board exist; the UI polls
  // briefStatus (pending -> analyzing -> ready|failed) to know when the
  // project's "brain" is ready.
  fastify.post("/projects", async (request, reply) => {
    const input = ProjectCreateInputSchema.parse(request.body);

    let repoPath: string;
    let repoUrl: string | null = null;
    if (input.repoUrl) {
      try {
        repoPath = await cloneProjectRepo(input.repoUrl, input.name);
      } catch (err) {
        if (err instanceof RepoCloneError) {
          reply.status(400).send({ error: "clone_failed", message: err.message });
          return;
        }
        throw err;
      }
      repoUrl = input.repoUrl;
    } else {
      repoPath = input.repoPath!;
      if (!isValidGitRepoRoot(repoPath)) {
        reply.status(400).send({ error: "invalid_repo", message: new InvalidRepoError(repoPath).message });
        return;
      }
    }

    const [project] = await fastify.db
      .insert(projects)
      .values({ name: input.name, repoPath, repoUrl, briefStatus: "analyzing" })
      .returning();
    if (!project) throw new Error("failed to insert project row");

    // A project with no board to dispatch cards from is dead weight, so
    // registration creates its board in the same request -- it shows up as
    // a selectable board on /board immediately, no separate step.
    const [board] = await fastify.db
      .insert(boards)
      .values({ name: project.name, description: `Project board for ${project.name}`, projectId: project.id })
      .returning();
    if (!board) throw new Error("failed to insert board row");

    void runProjectAnalyzerAgent({ id: project.id, name: project.name, repoPath: project.repoPath });

    reply.status(201).send({ project, board });
  });

  fastify.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const [project] = await fastify.db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    return project;
  });

  // Read-only JSON snapshot of a project's cards (any cardType, epics
  // included) for external consumption -- no docs/comments/activity, just
  // the cards table's own fields plus each card's epic linkage (the same
  // "first relates_to edge" derivation GET /cards uses via attachCardStatus,
  // reused directly here rather than through attachCardStatus so this
  // endpoint doesn't also leak activeAgentRun/blockedReason activity data).
  fastify.get<{ Params: { id: string } }>("/projects/:id/export", async (request, reply) => {
    const [project] = await fastify.db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) {
      reply.status(404).send({ error: "not_found", message: `no project exists with id ${request.params.id}` });
      return;
    }

    const projectBoards = await fastify.db.select({ id: boards.id }).from(boards).where(eq(boards.projectId, project.id));
    const boardIds = projectBoards.map((b) => b.id);

    const cardRows = boardIds.length ? await fastify.db.select().from(cards).where(inArray(cards.boardId, boardIds)) : [];
    const cardIds = cardRows.map((c) => c.id);

    const edges = cardIds.length
      ? await fastify.db
          .select({ cardId: cardDependencies.cardId, dependsOnCardId: cardDependencies.dependsOnCardId, dependencyType: cardDependencies.dependencyType })
          .from(cardDependencies)
          .where(inArray(cardDependencies.cardId, cardIds))
      : [];
    const referencedIds = [...new Set(edges.map((e) => e.dependsOnCardId))];
    const referencedCards = referencedIds.length
      ? await fastify.db.select({ id: cards.id, title: cards.title, state: cards.state }).from(cards).where(inArray(cards.id, referencedIds))
      : [];
    const dependencyInfo = buildDependencyInfoMap(cardIds, edges, referencedCards);

    reply.status(200).send({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      project: { id: project.id, name: project.name },
      cards: cardRows.map((card) => ({ ...card, epicId: dependencyInfo.get(card.id)?.epicId ?? null })),
    });
  });

  // The analyzer run that's currently building (or last built) this
  // project's brief -- lets the UI attach a live AgentSessionPanel via the
  // existing /agent-runs/:id/socket bridge (that route is keyed on
  // agentRunId alone, no card required, so this is the only piece that was
  // actually missing: a way to find *which* run to attach to for a project).
  fastify.get<{ Params: { id: string } }>("/projects/:id/analyzer-run", async (request, reply) => {
    const [run] = await fastify.db
      .select({ id: agentRuns.id, status: agentRuns.status, startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt })
      .from(agentRuns)
      .where(eq(agentRuns.projectId, request.params.id))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    if (!run) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    return run;
  });

  // Manual refresh: the brief is a snapshot taken once at registration, not
  // something that stays in sync with the repo as cards land -- there's no
  // scheduled re-analysis. This is the honest way to update it on demand
  // instead of pretending it's always current.
  fastify.post<{ Params: { id: string } }>("/projects/:id/reanalyze", async (request, reply) => {
    const [project] = await fastify.db.select().from(projects).where(eq(projects.id, request.params.id));
    if (!project) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    if (!isValidGitRepoRoot(project.repoPath)) {
      reply.status(400).send({ error: "invalid_repo", message: new InvalidRepoError(project.repoPath).message });
      return;
    }

    await fastify.db.update(projects).set({ briefStatus: "analyzing" }).where(eq(projects.id, project.id));
    void runProjectAnalyzerAgent({ id: project.id, name: project.name, repoPath: project.repoPath });

    reply.status(202).send({ briefStatus: "analyzing" });
  });
};
