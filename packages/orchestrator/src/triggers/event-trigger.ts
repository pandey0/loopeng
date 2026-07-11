import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@loopeng/db";
import { automations, cardDependencies, cards, eventLog } from "@loopeng/db";
import { runDeployPipeline } from "@loopeng/deploy-engine";
import { applyTransition, isReady } from "@loopeng/board-engine";
import type { CoordinationStrategy } from "../coordination/types.js";

const POLL_INTERVAL_MS = Number(process.env.ORCHESTRATOR_EVENT_POLL_MS ?? 5000);

// Every card that has a "blocks" dependency on `doneCardId` and is still
// sitting in backlog: promote it to ready if that was its last unmet
// blocker. A card can depend on more than one other card, so this re-checks
// isReady() per dependent rather than assuming clearing one edge clears the
// card -- only promotes when every blocker is actually done.
async function promoteUnblockedDependents(doneCardId: string): Promise<void> {
  const dependents = await db
    .select({ cardId: cardDependencies.cardId, state: cards.state })
    .from(cardDependencies)
    .innerJoin(cards, eq(cardDependencies.cardId, cards.id))
    .where(and(eq(cardDependencies.dependsOnCardId, doneCardId), eq(cardDependencies.dependencyType, "blocks")));

  for (const dependent of dependents) {
    if (dependent.state !== "backlog") continue;
    if (!(await isReady(dependent.cardId))) continue;
    await applyTransition({
      cardId: dependent.cardId,
      toState: "ready",
      actorType: "automation",
      reason: `auto-promoted: its last unmet dependency (${doneCardId}) reached done`,
    });
  }
}

// Polls event_log rather than using Postgres LISTEN/NOTIFY — simpler to run
// inside the same process as the Fastify API without managing a second raw
// connection, and event_log is the durable substrate anyway so polling
// never misses an event even across a restart (baseline is read from the
// table, not kept only in memory).
export function startEventTrigger(coordination: CoordinationStrategy): () => void {
  let lastId = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick() {
    if (stopped) return;
    try {
      const enabledEventAutomations = await db
        .select()
        .from(automations)
        .where(and(eq(automations.triggerType, "event"), eq(automations.enabled, true)));

      const rows = await db.select().from(eventLog).where(gt(eventLog.id, lastId)).orderBy(eventLog.id);
      for (const row of rows) {
        lastId = row.id;
        if (row.eventType !== "card.moved") continue;
        const payload = row.payload as { to?: string };
        const matches = enabledEventAutomations.some((a) => a.eventType === "card.state_changed");
        if (!matches) continue;

        if (payload.to === "ready") {
          // Mirrors cron-trigger's triage scan: a card dragged to "ready"
          // still has to clear its "blocks" dependencies before dispatch,
          // same as the scheduled path — event-driven isn't a bypass.
          if (!(await isReady(row.entityId))) continue;
          await coordination
            .dispatch(row.entityId)
            .catch((err) => console.error("[orchestrator:event-trigger] dispatch failed", err));
        } else if (payload.to === "deploying") {
          await runDeployPipeline(row.entityId).catch((err) =>
            console.error("[orchestrator:event-trigger] deploy pipeline failed", err),
          );
        } else if (payload.to === "done") {
          // The system deciding what to pick up next, not just a human
          // remembering to: a card sitting in backlog because it depended on
          // this one has no reason to wait for someone to notice and drag it
          // once its blocker is actually done. Auto-promote it to ready --
          // isReady() (checked per-dependent, since one might have other
          // still-unmet blockers) then lets the normal ready-dispatch branch
          // above pick it up on a later tick, same path a human drag takes.
          await promoteUnblockedDependents(row.entityId).catch((err) =>
            console.error("[orchestrator:event-trigger] dependent promotion failed", err),
          );
        }
      }
    } catch (err) {
      console.error("[orchestrator:event-trigger] poll failed", err);
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  void (async () => {
    const [latest] = await db.select().from(eventLog).orderBy(desc(eventLog.id)).limit(1);
    lastId = latest?.id ?? 0;
    void tick();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
