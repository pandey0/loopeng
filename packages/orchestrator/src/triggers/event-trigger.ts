import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@loopeng/db";
import { automations, cardDependencies, cards, eventLog } from "@loopeng/db";
import { runDeployPipeline } from "@loopeng/deploy-engine";
import { applyTransition, isReady } from "@loopeng/board-engine";
import type { CoordinationStrategy } from "../coordination/types.js";

const POLL_INTERVAL_MS = Number(process.env.ORCHESTRATOR_EVENT_POLL_MS ?? 5000);

// Every card that has a "blocks" dependency on `doneCardId`: promote it to
// ready if that was its last unmet blocker (backlog case), or dispatch it
// directly if it's already sitting in ready (a human -- or a stale board
// state -- can put a card in ready before its dependency actually finished;
// its own ready-transition event would have found isReady() false back
// then and skipped dispatch, and nothing else was ever going to re-check it
// once this dependency actually landed). A card can depend on more than one
// other card, so this re-checks isReady() per dependent rather than
// assuming clearing one edge clears the card -- only acts once every
// blocker is actually done.
//
// Regression: a card manually dragged to ready ahead of its dependency
// finishing sat there forever even after the dependency reached done --
// this only ever promoted backlog cards, silently ignoring ready ones.
// Caught live: a card moved to ready before its blocker merged never
// kicked off even once the blocker was done.
export async function promoteUnblockedDependents(doneCardId: string, coordination: CoordinationStrategy): Promise<void> {
  const dependents = await db
    .select({ cardId: cardDependencies.cardId, state: cards.state })
    .from(cardDependencies)
    .innerJoin(cards, eq(cardDependencies.cardId, cards.id))
    .where(and(eq(cardDependencies.dependsOnCardId, doneCardId), eq(cardDependencies.dependencyType, "blocks")));

  for (const dependent of dependents) {
    if (dependent.state !== "backlog" && dependent.state !== "ready") continue;
    if (!(await isReady(dependent.cardId))) continue;

    if (dependent.state === "backlog") {
      await applyTransition({
        cardId: dependent.cardId,
        toState: "ready",
        actorType: "automation",
        reason: `auto-promoted: its last unmet dependency (${doneCardId}) reached done`,
      });
      continue;
    }

    // Already in ready -- no transition to make, just dispatch it now
    // instead of leaving it for a boot sweep or cron triage to find.
    await coordination
      .dispatch(dependent.cardId)
      .catch((err) => console.error("[orchestrator:event-trigger] dependent dispatch failed", err));
  }
}

// Boot-time cursor init (below) sets lastId to whatever's already in
// event_log, so any card.moved-to-ready event OLDER than that -- including
// one from a card that was never actually dispatched, because the process
// restarted before its tick ran -- becomes invisible to the poll loop
// forever. Confirmed live: two real cards sat in "ready" for hours,
// silently never picked up, purely because their ready-transition predated
// a later boot. This sweeps current state instead of past events: any card
// sitting in ready right now gets the same isReady()-gated dispatch a fresh
// event would, once per boot, so a restart can never strand a ready card
// indefinitely (only the once-daily cron morning-triage would otherwise
// catch it).
async function sweepReadyCardsAtBoot(coordination: CoordinationStrategy): Promise<void> {
  const readyCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.state, "ready"));
  for (const card of readyCards) {
    if (!(await isReady(card.id))) continue;
    await coordination.dispatch(card.id).catch((err) => console.error("[orchestrator:event-trigger] boot sweep dispatch failed", err));
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
          await promoteUnblockedDependents(row.entityId, coordination).catch((err) =>
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
    await sweepReadyCardsAtBoot(coordination).catch((err) => console.error("[orchestrator:event-trigger] boot sweep failed", err));
    void tick();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
