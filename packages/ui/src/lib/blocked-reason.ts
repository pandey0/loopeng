// packages/board-engine/src/card-status.ts::buildBlockedReasonMap always
// writes blockedReason as either "waiting on answer: <question>" (an agent
// raised a QUESTION: escalation -- only a human can resolve it) or one of
// several system-failure shapes (gate/reviewer/implementer failure -- an
// automatic retry can resolve it without anyone answering anything). This
// prefix is the one reliable signal distinguishing the two from the client.
const HUMAN_BLOCKED_PREFIX = "waiting on answer:";

export function isHumanBlocked(blockedReason: string | null | undefined): boolean {
  return !!blockedReason?.startsWith(HUMAN_BLOCKED_PREFIX);
}

// packages/orchestrator/src/reconcile.ts writes this exact substring for the
// one blocked reason that genuinely does resolve itself: a run orphaned by
// an api restart, where nothing about the card's actual work was wrong.
// reconcile.ts auto-requeues it immediately (blocked -> ready, capped at
// MAX_AUTO_REQUEUE attempts) -- this is only ever visible in the brief
// window before that happens, or on the rare card that hit the cap. Every
// *other* system-blocked reason (a failing gate, a rejected review, a
// crashed implementer) needs an actual fix before a retry means anything;
// claiming those "auto-retry" too would just be wrong.
const RESTART_ORPHAN_MARKER = 'interrupted (stuck in "';

export function isAutoRetrying(blockedReason: string | null | undefined): boolean {
  return !!blockedReason?.includes(RESTART_ORPHAN_MARKER);
}
