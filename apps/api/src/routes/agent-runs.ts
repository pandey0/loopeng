import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, createApiKey, db, eventLog, revokeApiKey } from "@loopeng/db";
import { getRoleId } from "@loopeng/agents";

const AgentRunCreateInputSchema = z.object({ worktreeId: z.string().uuid().nullable().optional() });
const AgentRunFinishInputSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  logsRef: z.string().nullable().optional(),
});

// Card 438646e5: the sub-agent MCP server process (spawned inside an
// agent's own worktree -- buildSubAgentMcpConfig in @loopeng/agents) used to
// book-keep delegated agent_runs rows with a raw DB credential
// (loopeng_agent_runs, migrations 0011/0012) that had table-wide grants --
// every card's run history, not just its own. An untracked psql session
// with that credential could silently overwrite or blank out another
// card's run status/verdict/transcript with zero trace in event_log, and
// the credential itself sat in cleartext in .env.example. These two routes
// replace that entirely (migration 0013 revokes the role): a sub-agent run
// is now created and finished exactly like every other card mutation, over
// the authenticated API, scoped to whatever card/project/board (or none)
// the caller's own agent_runs row was already scoped to -- inherited
// server-side from the verified caller's own identity, never accepted from
// the request body.
export const agentRunRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/agent-runs", { preHandler: fastify.requireActor }, async (request, reply) => {
    const actor = request.actor!;
    if (actor.type !== "agent" || !actor.id) {
      reply.status(403).send({ error: "forbidden", message: "only an agent-scoped caller can create a sub-agent run" });
      return;
    }
    const input = AgentRunCreateInputSchema.parse(request.body ?? {});

    const [parent] = await db
      .select({ cardId: agentRuns.cardId, projectId: agentRuns.projectId, boardId: agentRuns.boardId })
      .from(agentRuns)
      .where(eq(agentRuns.id, actor.id));
    if (!parent) {
      reply.status(404).send({ error: "not_found", message: "no agent_runs row for this caller" });
      return;
    }

    const roleId = await getRoleId("implementer");
    const [run] = await db
      .insert(agentRuns)
      .values({
        cardId: parent.cardId,
        projectId: parent.projectId,
        boardId: parent.boardId,
        agentRoleId: roleId,
        worktreeId: input.worktreeId ?? null,
        parentAgentRunId: actor.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    if (!run) throw new Error("failed to insert agent_runs row for sub-agent");

    const { token } = await createApiKey({ actorType: "agent", actorId: run.id, label: `agent-run:${run.id}` });

    await db.insert(eventLog).values({
      entityType: parent.cardId ? "card" : "agent_run",
      entityId: parent.cardId ?? run.id,
      eventType: "agent_run.delegated",
      actorType: "agent",
      actorId: actor.id,
      payload: { agentRunId: run.id },
    });

    reply.status(201).send({ id: run.id, apiKey: token });
  });

  fastify.post("/agent-runs/:runId/finish", { preHandler: fastify.requireActor }, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const actor = request.actor!;
    // Self-only: a run can only mark itself finished, with its own
    // single-run-scoped key -- never another run's, including its own
    // parent's (whose key stays valid for spawning further children, not
    // for closing out ones it already delegated away).
    if (actor.type !== "agent" || actor.id !== runId) {
      reply.status(403).send({ error: "forbidden", message: "a run can only finish itself" });
      return;
    }
    const input = AgentRunFinishInputSchema.parse(request.body);

    const [run] = await db.select({ cardId: agentRuns.cardId }).from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run) {
      reply.status(404).send({ error: "not_found" });
      return;
    }

    await db
      .update(agentRuns)
      .set({ status: input.status, logsRef: input.logsRef ?? null, finishedAt: new Date() })
      .where(eq(agentRuns.id, runId));

    await db.insert(eventLog).values({
      entityType: run.cardId ? "card" : "agent_run",
      entityId: run.cardId ?? runId,
      eventType: "agent_run.completed",
      actorType: "agent",
      actorId: runId,
      payload: { status: input.status },
    });

    // Revoked once finished so a leaked/logged token can't be replayed
    // after this run's own turn is over -- it already did the one thing
    // (mark itself finished) it will ever legitimately need to do again.
    await revokeApiKey(actor.apiKeyId);

    reply.status(204).send();
  });
};
