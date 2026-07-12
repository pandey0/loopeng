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

// The single "forward" edge out of each non-terminal state, used by the card
// detail page's "move to next step" button -- a convenience for the exact
// move a human could already make by dragging the card one column over, not
// a new state machine. Every value here is a real TRANSITIONS edge (picking
// the forward/happy-path branch where a state has more than one legal
// target, e.g. in_review also allows done/blocked and gate_checks also
// allows deploying/blocked) so this can never grant a move canTransition
// would reject. A prior version of this walked a fixed column-order list
// instead, which sent blocked -> done (not a legal edge -- would throw) and
// deploy_failed -> blocked (legal, but not the documented "retry just the
// deploy step" recovery path above) -- caught live by an integrator agent
// rebasing two independent implementations of the /advance endpoint.
export const NEXT_STATE: Partial<Record<CardState, CardState>> = {
  backlog: "ready",
  ready: "in_progress",
  in_progress: "in_review",
  in_review: "gate_checks",
  gate_checks: "awaiting_approval",
  awaiting_approval: "deploying",
  deploying: "done",
  deploy_failed: "deploying",
  blocked: "ready",
};

export function getNextState(from: CardState): CardState | null {
  return NEXT_STATE[from] ?? null;
}
