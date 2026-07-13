import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";
import { boards, cards, gateDefinitions, gateResults } from "@loopeng/db";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Health dashboard's only data source: deploy-engine already writes one
// gate_results row per attempt against the deploy_live gate (see
// deploy-engine/src/pipeline.ts), so "recent deploy attempts" is just those
// rows, newest first, joined to the card/board they belong to. No new table.
export const deployRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/deploys", async (request) => {
    const { limit } = request.query as { limit?: string };
    const take = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);

    return fastify.db
      .select({
        id: gateResults.id,
        status: gateResults.status,
        detail: gateResults.detail,
        createdAt: gateResults.createdAt,
        card: { id: cards.id, title: cards.title },
        board: { id: boards.id, name: boards.name },
      })
      .from(gateResults)
      .innerJoin(gateDefinitions, eq(gateResults.gateDefinitionId, gateDefinitions.id))
      .innerJoin(cards, eq(gateResults.cardId, cards.id))
      .leftJoin(boards, eq(cards.boardId, boards.id))
      .where(eq(gateDefinitions.key, "deploy_live"))
      .orderBy(desc(gateResults.createdAt))
      .limit(take);
  });
};
