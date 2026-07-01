import cron from "node-cron";
import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { automationRuns, automations, cards } from "@loopeng/db";
import { isReady } from "@loopeng/board-engine";
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

// Reads the automations table for enabled cron triggers and schedules them
// with node-cron. Only "triage_scan" is implemented today (dispatch every
// dependency-unblocked ready card); other action types are logged and
// skipped so misconfigured rows fail loud instead of silently.
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
        } else {
          console.warn(`[orchestrator:cron] automation "${automation.name}" has unsupported action type: ${action.type}`);
        }
      });
      console.log(`[orchestrator:cron] scheduled "${automation.name}" (${automation.scheduleCron})`);
    }
  })();
}
