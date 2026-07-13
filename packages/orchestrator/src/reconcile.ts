import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, cards, eventLog } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import type { CardState } from "@loopeng/shared";
import { RATE_LIMIT_MARKER, resolveRateLimitRetryAt } from "./loop.js";

// States where a card's next move is genuinely owned by an in-flight agent
// run -- not awaiting_approval (no run is active by definition, a human owns
// the next move) or deploying (handled separately by the event trigger).
const AGENT_OWNED_STATES: CardState[] = ["in_progress", "in_review", "gate_checks"];

// Distinguishes this specific reason from every other way a card can end up
// blocked -- a marker, not prose the user reads, so keep it exact and
// check for it verbatim below.
const RESTART_ORPHAN_MARKER = 'interrupted (stuck in "';

// A restart orphan isn't a real failure of the work -- nothing about the
// card's actual state is wrong, only the process babysitting it died. Auto-
// requeuing it is always safe, unlike a failed gate or a rejected review,
// which need an actual fix before retrying means anything. Capped so a card
// that's *genuinely* unable to run (crashes every single time, for a real
// reason) doesn't get silently re-queued forever, burning agent runs with
// no human ever seeing it -- past this many restart-orphan blocks, it's
// left for a human instead of requeued again.
const MAX_AUTO_REQUEUE = 3;

async function countPriorRestartOrphanBlocks(cardId: string): Promise<number> {
  const rows = await db
    .select({ payload: eventLog.payload })
    .from(eventLog)
    .where(and(eq(eventLog.entityType, "card"), eq(eventLog.entityId, cardId), eq(eventLog.eventType, "card.moved")));
  return rows.filter((row) => {
    const payload = row.payload as { reason?: string };
    return typeof payload.reason === "string" && payload.reason.includes(RESTART_ORPHAN_MARKER);
  }).length;
}

// Runs once at boot, before the cron/event triggers start. An api restart
// wipes the in-memory sessionRegistry and orchestrator loop state, but a
// card's `state` column and its agent_runs rows don't know that -- a card
// can be left sitting in an agent-owned state forever with a run stuck at
// status=running/verifying, a dead watch link, and (this was the actual
// gap) *no visible reason at all*: buildBlockedReasonMap
// (packages/board-engine/src/card-status.ts) only ever explains a card
// that's already "blocked", so an orphan still sitting in_progress just
// looks like nothing is happening, silently, forever. Recorded live on
// 2026-07-11: a card orphaned by a dev-loop api restart sat in_progress
// with no indication anything was wrong until manually investigated.
//
// This closes the gap at the source instead of only explaining it after
// the fact: sweep once per boot, mark the dead run failed, and requeue the
// card to blocked with the same real-reason mechanism every other blocking
// path already uses -- it shows up in /inbox immediately, one click from
// "Retry" back to ready, instead of a silent dead end.
export async function reconcileOrphanedRuns(): Promise<number> {
  const stale = await db
    .select({
      cardId: cards.id,
      cardState: cards.state,
      runId: agentRuns.id,
      runStatus: agentRuns.status,
      startedAt: agentRuns.startedAt,
      roleName: agentRoles.name,
    })
    .from(cards)
    .innerJoin(agentRuns, eq(agentRuns.cardId, cards.id))
    .leftJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
    .where(and(inArray(cards.state, AGENT_OWNED_STATES), inArray(agentRuns.status, ["running", "verifying"])));

  // A card can have more than one stuck run only if something already went
  // very wrong; act on the most recently started one per card.
  const latestByCard = new Map<string, (typeof stale)[number]>();
  for (const row of stale) {
    const existing = latestByCard.get(row.cardId);
    if (!existing || (row.startedAt ?? new Date(0)) > (existing.startedAt ?? new Date(0))) {
      latestByCard.set(row.cardId, row);
    }
  }

  for (const row of latestByCard.values()) {
    await db.update(agentRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(agentRuns.id, row.runId));
    const role = row.roleName ?? "agent";
    await applyTransition({
      cardId: row.cardId,
      toState: "blocked",
      actorType: "automation",
      reason: `${role} run ${RESTART_ORPHAN_MARKER}${row.runStatus}" at boot -- likely an api restart mid-run)`,
    });

    const priorBlocks = await countPriorRestartOrphanBlocks(row.cardId);
    if (priorBlocks <= MAX_AUTO_REQUEUE) {
      await applyTransition({
        cardId: row.cardId,
        toState: "ready",
        actorType: "automation",
        reason: `auto-requeued: a restart orphan isn't a real failure, safe to retry automatically (${priorBlocks}/${MAX_AUTO_REQUEUE})`,
      });
    }
  }

  return latestByCard.size;
}

// scheduleRateLimitRetryAt (loop.ts) arms a bare setTimeout the moment a
// card is blocked for a rate limit -- a fast path for the common case, but
// not something this function depends on. Recorded live on 2026-07-13:
// seven cards blocked for a session-limit reset sat 80+ minutes past their
// own stated retry time, in the *same continuously-running process* that
// scheduled them (no restart, no gap between process uptime and wall-clock
// elapsed time -- ruled out by comparing /proc's process start time against
// the block events' timestamps). The exact reason a single long-duration
// setTimeout silently failed to fire was never pinned down, and doesn't need
// to be: relying on any one in-memory timer firing correctly, across
// however many hours a session-limit window can run, is inherently fragile.
// This function is the actual correctness guarantee -- called from
// startRateLimitReconcileLoop below on a short interval, so a single dead
// timer, a process restart, or the machine being shut down overnight all
// self-heal within one poll instead of depending on any timer at all.
//
// Sweep blocked cards whose most recent card.moved event is a rate-limit
// block, and re-derive the target instant resolveRateLimitRetryAt originally
// computed -- by re-parsing the "resets HH:MM (Zone)" clause preserved
// verbatim in the persisted reason, using that event's own createdAt as the
// reference time (so "next occurrence on/after the block" reproduces the
// original target regardless of how much later this sweep actually runs).
// Comparing that fixed target against the real current time is what makes
// this correct no matter how long it's been -- requeue if overdue, otherwise
// leave it for the next poll to re-check.
export async function reconcileRateLimitedCards(): Promise<number> {
  const blocked = await db.select({ id: cards.id }).from(cards).where(eq(cards.state, "blocked"));
  if (blocked.length === 0) return 0;

  let requeued = 0;
  for (const card of blocked) {
    const [latestMove] = await db
      .select({ payload: eventLog.payload, createdAt: eventLog.createdAt })
      .from(eventLog)
      .where(and(eq(eventLog.entityType, "card"), eq(eventLog.entityId, card.id), eq(eventLog.eventType, "card.moved")))
      .orderBy(desc(eventLog.createdAt))
      .limit(1);
    if (!latestMove) continue;

    const payload = latestMove.payload as { to?: string; reason?: string };
    if (payload.to !== "blocked" || !payload.reason?.startsWith(RATE_LIMIT_MARKER)) continue;

    const retryAt = resolveRateLimitRetryAt(payload.reason, latestMove.createdAt);
    if (retryAt.getTime() <= Date.now()) {
      await applyTransition({
        cardId: card.id,
        toState: "ready",
        actorType: "automation",
        reason: "auto-retrying after rate-limit backoff (requeued by the periodic reconcile sweep)",
      });
      requeued++;
    }
  }

  return requeued;
}

// Self-rescheduling poll, same shape as triggers/event-trigger.ts's tick
// loop -- the actual backstop for reconcileRateLimitedCards above. Started
// from startOrchestrator (so it only runs on the one real
// ORCHESTRATOR_ENABLED instance, same reasoning as the rest of that gate)
// and stopped alongside everything else on shutdown. Reads the poll
// interval env var at call time, not module load -- lets a test override it
// per-call without needing a fresh module import.
export function startRateLimitReconcileLoop(): () => void {
  const pollIntervalMs = Number(process.env.ORCHESTRATOR_RATE_LIMIT_POLL_MS ?? 60 * 1000);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick() {
    if (stopped) return;
    try {
      await reconcileRateLimitedCards();
    } catch (err) {
      console.error("[orchestrator:reconcile] rate-limit poll failed", err);
    }
    if (!stopped) {
      timer = setTimeout(tick, pollIntervalMs);
      timer.unref();
    }
  }

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
