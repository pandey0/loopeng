import { describe, expect, it } from "vitest";
import { CARD_STATES } from "./enums";
import type { CardState } from "./enums";
import { canTransition, getNextState, NEXT_STATE, TRANSITIONS } from "./state-machine";

describe("TRANSITIONS", () => {
  it("has an entry for every card state", () => {
    for (const state of CARD_STATES) {
      expect(TRANSITIONS[state]).toBeDefined();
    }
  });

  it("only points at other known card states", () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) {
        expect(CARD_STATES).toContain(target);
      }
    }
  });
});

describe("canTransition", () => {
  it("allows a card to move along the state machine's declared edges", () => {
    expect(canTransition("backlog", "ready")).toBe(true);
    expect(canTransition("in_review", "gate_checks")).toBe(true);
    expect(canTransition("blocked", "in_progress")).toBe(true);
  });

  it("rejects transitions that skip states", () => {
    expect(canTransition("backlog", "in_progress")).toBe(false);
    expect(canTransition("backlog", "done")).toBe(false);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransition("done", "backlog")).toBe(false);
    expect(canTransition("cancelled", "backlog")).toBe(false);
  });

  it("rejects a no-op transition into the same state", () => {
    expect(canTransition("ready", "ready")).toBe(false);
  });
});

describe("deploy_failed recovery", () => {
  it("routes a deploy failure to deploy_failed, not blocked", () => {
    expect(canTransition("deploying", "deploy_failed")).toBe(true);
    expect(canTransition("deploying", "blocked")).toBe(false);
  });

  it("allows retrying just the deploy step, without re-approval", () => {
    expect(canTransition("deploy_failed", "deploying")).toBe(true);
  });

  it("still allows escalating to a full re-implementation cycle when the code itself needs to change", () => {
    expect(canTransition("deploy_failed", "blocked")).toBe(true);
    expect(canTransition("blocked", "ready")).toBe(true);
  });

  it("does not let a deploy_failed card skip straight to done", () => {
    expect(canTransition("deploy_failed", "done")).toBe(false);
  });
});

describe("getNextState", () => {
  it("walks the happy path forward one column at a time", () => {
    expect(getNextState("backlog")).toBe("ready");
    expect(getNextState("ready")).toBe("in_progress");
    expect(getNextState("in_progress")).toBe("in_review");
    expect(getNextState("in_review")).toBe("gate_checks");
    expect(getNextState("gate_checks")).toBe("awaiting_approval");
    expect(getNextState("awaiting_approval")).toBe("deploying");
    expect(getNextState("deploying")).toBe("done");
  });

  // Regression: an earlier version derived this by walking a fixed
  // column-order list instead of an explicit per-state edge. That sent
  // blocked -> done (not a legal TRANSITIONS edge -- throws at
  // applyTransition time) and deploy_failed -> blocked (legal, but not the
  // documented "retry just the deploy step" recovery path). Caught live by
  // an integrator agent rebasing two independent implementations of the
  // /advance endpoint.
  it("routes recovery states back onto the happy path, not into a dead end", () => {
    expect(getNextState("blocked")).toBe("ready");
    expect(getNextState("deploy_failed")).toBe("deploying");
  });

  it("every declared edge is a legal transition, by construction", () => {
    for (const [from, to] of Object.entries(NEXT_STATE) as [CardState, CardState][]) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("returns null for terminal states and states with no declared forward edge", () => {
    expect(getNextState("done")).toBeNull();
    expect(getNextState("cancelled")).toBeNull();
  });
});
