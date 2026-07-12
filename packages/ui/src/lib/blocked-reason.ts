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

// Two blocked reasons genuinely resolve themselves, both written by the
// orchestrator, not a human: a run orphaned by an api restart
// (packages/orchestrator/src/reconcile.ts, auto-requeued immediately,
// capped at MAX_AUTO_REQUEUE) and a CLI call that hit the account's own
// rate/session limit (packages/orchestrator/src/loop.ts, scheduled for a
// later automatic retry, not counted against the card's normal retry
// attempts). Neither is a real problem with the card's work. Every *other*
// system-blocked reason (a failing gate, a genuinely rejected review, a
// crashed implementer) needs an actual fix before a retry means anything;
// claiming those "auto-retry" too would just be wrong.
const AUTO_RETRY_MARKERS = ['interrupted (stuck in "', "rate-limited, not a real failure"];

export function isAutoRetrying(blockedReason: string | null | undefined): boolean {
  return !!blockedReason && AUTO_RETRY_MARKERS.some((marker) => blockedReason.includes(marker));
}
