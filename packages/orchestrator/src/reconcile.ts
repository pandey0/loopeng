import { and, eq, inArray } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, cards } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import type { CardState } from "@loopeng/shared";

// States where a card's next move is genuinely owned by an in-flight agent
// run -- not awaiting_approval (no run is active by definition, a human owns
// the next move) or deploying (handled separately by the event trigger).
const AGENT_OWNED_STATES: CardState[] = ["in_progress", "in_review", "gate_checks"];

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
      reason: `${role} run interrupted (stuck in "${row.runStatus}" at boot -- likely an api restart mid-run)`,
    });
  }

  return latestByCard.size;
}
