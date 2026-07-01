import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import { cards, eventLog } from "@loopeng/db";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const POLL_INTERVAL_MS = Number(process.env.EVENTS_STREAM_POLL_MS ?? 2000);
const HEARTBEAT_INTERVAL_MS = 15000;

type EventRow = typeof eventLog.$inferSelect;

interface EventQuery {
  boardId?: string;
  entityType?: string;
  entityId?: string;
  limit?: string;
  afterId?: string;
}

async function resolveBoardCardIds(db: FastifyInstance["db"], boardId: string): Promise<string[]> {
  const rows = await db.select({ id: cards.id }).from(cards).where(eq(cards.boardId, boardId));
  return rows.map((r) => r.id);
}

// event_log is polymorphic (entity_type + entity_id, no FK), so "events for
// this board" only resolves for the entity types actually written today:
// 'card' events use the card id directly as entity_id, and 'doc' events
// (doc.drift_detected) carry the originating card id in payload.cardId.
function boardScopeCondition(boardCardIds: string[]): SQL | undefined {
  return or(
    and(eq(eventLog.entityType, "card"), inArray(eventLog.entityId, boardCardIds)),
    and(eq(eventLog.entityType, "doc"), inArray(sql`${eventLog.payload}->>'cardId'`, boardCardIds)),
  );
}

export function matchesBoard(row: EventRow, boardCardIds: string[]): boolean {
  if (row.entityType === "card") return boardCardIds.includes(row.entityId);
  if (row.entityType === "doc") return boardCardIds.includes((row.payload as { cardId?: string }).cardId ?? "");
  return false;
}

export const eventRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/events", async (request) => {
    const { boardId, entityType, entityId, limit, afterId } = request.query as EventQuery;
    const take = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);

    const conditions: SQL[] = [];
    if (entityType) conditions.push(eq(eventLog.entityType, entityType));
    if (entityId) conditions.push(eq(eventLog.entityId, entityId));
    if (afterId) conditions.push(gt(eventLog.id, Number(afterId)));

    if (boardId) {
      const boardCardIds = await resolveBoardCardIds(fastify.db, boardId);
      if (boardCardIds.length === 0) return [];
      const scoped = boardScopeCondition(boardCardIds);
      if (scoped) conditions.push(scoped);
    }

    return fastify.db
      .select()
      .from(eventLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(eventLog.id))
      .limit(take);
  });

  // Polls event_log rather than LISTEN/NOTIFY, matching the orchestrator's
  // event-trigger — durable and simple, and cheap at this poll interval.
  fastify.get("/events/stream", async (request, reply) => {
    const { boardId, entityType } = request.query as EventQuery;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.hijack();

    const boardCardIds = boardId ? await resolveBoardCardIds(fastify.db, boardId) : null;

    const [latest] = await fastify.db.select().from(eventLog).orderBy(desc(eventLog.id)).limit(1);
    let lastId = latest?.id ?? 0;

    function matchesFilter(row: EventRow): boolean {
      if (entityType && row.entityType !== entityType) return false;
      if (boardCardIds) return matchesBoard(row, boardCardIds);
      return true;
    }

    async function poll() {
      const rows = await fastify.db.select().from(eventLog).where(gt(eventLog.id, lastId)).orderBy(eventLog.id);
      for (const row of rows) {
        lastId = row.id;
        if (matchesFilter(row)) {
          reply.raw.write(`event: activity\ndata: ${JSON.stringify(row)}\n\n`);
        }
      }
    }

    const pollTimer = setInterval(() => {
      poll().catch((err) => fastify.log.error(err, "events/stream poll failed"));
    }, POLL_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => reply.raw.write(": heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);

    request.raw.on("close", () => {
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      reply.raw.end();
    });
  });
};
