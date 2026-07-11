import type { CardState } from "./enums";

// Full state graph reserved from day one so Phase 3/4 gate-driven states
// (gate_checks, awaiting_approval, deploying) don't require a data migration
// reshuffling card history once they go live. Phase 1 only exercises the
// backlog/ready/in_progress/in_review/done/blocked/cancelled subset, plus a
// direct in_review -> done edge for humans moving cards manually before any
// gate pipeline exists (Phase 3 will route through gate_checks instead).
//
// deploy_failed is a separate lane from blocked: a deploy that fails after
// implementer/reviewer/gates (and, for high risk, human approval) already
// passed is almost always an infra/mechanics problem (pre-check, transient
// docker error, flaky health check), not a code problem. Routing it through
// "blocked" would force the only sanctioned recovery (blocked -> ready) to
// re-run the entire implementer -> reviewer -> gates -> awaiting_approval
// cycle and make the product owner re-approve code that never changed.
// deploy_failed -> deploying retries just the deploy step directly. A human
// who decides the failure *does* need code changes can still send the card
// to blocked -> ready for the full cycle.
export const TRANSITIONS: Record<CardState, CardState[]> = {
  backlog: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["in_review", "blocked"],
  in_review: ["gate_checks", "done", "blocked"],
  gate_checks: ["awaiting_approval", "deploying", "blocked"],
  awaiting_approval: ["deploying", "blocked"],
  deploying: ["done", "deploy_failed"],
  deploy_failed: ["deploying", "blocked"],
  blocked: ["in_progress", "ready"],
  done: [],
  cancelled: [],
};

export function canTransition(from: CardState, to: CardState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// The board's single ordered column list -- same order the board UI renders
// columns in (apps/web/app/board/page.tsx PHASE_3_COLUMNS). Drag-and-drop can
// jump to any column canTransition allows (not just the adjacent one); this
// order is what "advance to next column" walks. cancelled has no column and
// is reached only via backlog/ready's "cancel" edge, so it's excluded here.
export const BOARD_COLUMN_ORDER: readonly CardState[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "gate_checks",
  "awaiting_approval",
  "deploying",
  "deploy_failed",
  "blocked",
  "done",
];

// null means "no next column" -- either state is the last column (done) or
// isn't part of the ordered list at all (cancelled).
export function nextBoardState(state: CardState): CardState | null {
  const idx = BOARD_COLUMN_ORDER.indexOf(state);
  if (idx === -1 || idx === BOARD_COLUMN_ORDER.length - 1) return null;
  return BOARD_COLUMN_ORDER[idx + 1] ?? null;
}
