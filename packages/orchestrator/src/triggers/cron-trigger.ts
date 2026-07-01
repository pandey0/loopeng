import cron from "node-cron";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { automationRuns, automations, cards, eventLog } from "@loopeng/db";
import { isReady } from "@loopeng/board-engine";
import { findStaleDocs } from "@loopeng/doc-engine";
import type { CoordinationStrategy } from "../coordination/types.js";

async function runTriageScan(automationId: string, target: Record<string, unknown>, coordination: CoordinationStrategy) {
  const [run] = await db.insert(automationRuns).values({ automationId, status: "running" }).returning();

  const boardId = target.boardId as string | undefined;
  const readyCards = boardId
    ? await db.select().from(cards).where(and(eq(cards.boardId, boardId), eq(cards.state, "ready")))
    : await db.select().from(cards).where(eq(cards.state, "ready"));

  let dispatched = 0;
  for (const card of readyCards) {
    if (await isReady(card.id)) {
      await coordination.dispatch(card.id);
      dispatched++;
    }
  }

  if (run) {
    await db
      .update(automationRuns)
      .set({ status: "succeeded", result: { dispatched, scanned: readyCards.length }, finishedAt: new Date() })
      .where(eq(automationRuns.id, run.id));
  }
}

// A doc counts as "already flagged" (skip re-inserting) if its most recent
// doc.drift_detected event is still newer than the doc's last update — i.e.
// nothing has changed since we last flagged it. If the doc was touched
// again after that event, this is a fresh staleness window worth a new
// event, so re-running the scan doesn't spam duplicates but still re-flags
// genuinely new drift.
async function isAlreadyFlagged(stale: Awaited<ReturnType<typeof findStaleDocs>>[number]): Promise<boolean> {
  const [lastEvent] = await db
    .select()
    .from(eventLog)
    .where(and(eq(eventLog.entityType, "doc"), eq(eventLog.entityId, stale.docId), eq(eventLog.eventType, "doc.drift_detected")))
    .orderBy(desc(eventLog.createdAt))
    .limit(1);
  if (!lastEvent) return false;
  return lastEvent.createdAt >= stale.docLastVerifiedAt;
}

async function runDocDriftScan(automationId: string) {
  const [run] = await db.insert(automationRuns).values({ automationId, status: "running" }).returning();

  const staleDocs = await findStaleDocs();
  let flagged = 0;
  for (const stale of staleDocs) {
    if (await isAlreadyFlagged(stale)) continue;
    await db.insert(eventLog).values({
      entityType: "doc",
      entityId: stale.docId,
      eventType: "doc.drift_detected",
      actorType: "automation",
      payload: { cardId: stale.cardId, cardTitle: stale.cardTitle, docSlug: stale.slug },
    });
    flagged++;
  }

  if (run) {
    await db
      .update(automationRuns)
      .set({
        status: "succeeded",
        result: { staleCount: staleDocs.length, newlyFlagged: flagged },
        finishedAt: new Date(),
      })
      .where(eq(automationRuns.id, run.id));
  }
}

// Reads the automations table for enabled cron triggers and schedules them
// with node-cron. "triage_scan" dispatches every dependency-unblocked ready
// card; "doc_drift_scan" flags docs whose linked card shipped after the doc
// was last touched (see @loopeng/doc-engine findStaleDocs). Other action
// types are logged and skipped so misconfigured rows fail loud instead of
// silently.
export function startCronTriggers(coordination: CoordinationStrategy): void {
  void (async () => {
    const rows = await db
      .select()
      .from(automations)
      .where(and(eq(automations.triggerType, "cron"), eq(automations.enabled, true)));

    for (const automation of rows) {
      if (!automation.scheduleCron) continue;
      const action = automation.action as { type?: string };
      cron.schedule(automation.scheduleCron, () => {
        if (action.type === "triage_scan") {
          void runTriageScan(automation.id, (automation.target as Record<string, unknown>) ?? {}, coordination);
        } else if (action.type === "doc_drift_scan") {
          void runDocDriftScan(automation.id);
        } else {
          console.warn(`[orchestrator:cron] automation "${automation.name}" has unsupported action type: ${action.type}`);
        }
      });
      console.log(`[orchestrator:cron] scheduled "${automation.name}" (${automation.scheduleCron})`);
    }
  })();
}
