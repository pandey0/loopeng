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
