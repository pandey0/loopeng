import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, cards, eventLog } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import type { CardState } from "@loopeng/shared";
import { RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_MARKER, scheduleRateLimitRetry } from "./loop.js";

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

// scheduleRateLimitRetry (loop.ts) arms a bare setTimeout the moment a card
// is blocked for a rate limit -- nothing persists *when* it's due, so an api
// restart before it fires (deploy, crash, dev-loop restart) drops the
// pending requeue silently and the card is stuck in "blocked" forever, with
// its blockedReason (buildBlockedReasonMap) never even surfacing the
// rate-limit prose since that reason only lives on the card.moved event, not
// on any row buildBlockedReasonMap reads. Recorded live on 2026-07-12: two
// cards blocked for a session-limit reset sat well past their own stated
// "~20 min" window with no further activity after an unrelated api restart.
//
// Runs once at boot, same as reconcileOrphanedRuns: sweep blocked cards
// whose most recent card.moved event is a rate-limit block, and either
// requeue immediately (if the backoff window already elapsed -- the common
// case after any outage that takes more than a few minutes to notice and
// recover from) or re-arm a timer for whatever's left of it.
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

    const elapsedMs = Date.now() - latestMove.createdAt.getTime();
    const remainingMs = RATE_LIMIT_BACKOFF_MS - elapsedMs;
    if (remainingMs <= 0) {
      await applyTransition({
        cardId: card.id,
        toState: "ready",
        actorType: "automation",
        reason: "auto-retrying after rate-limit backoff (requeued at boot -- the original timer was lost to a process restart)",
      });
      requeued++;
    } else {
      scheduleRateLimitRetry(card.id, remainingMs);
    }
  }

  return requeued;
}
