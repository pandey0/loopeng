import { describe, expect, it } from "vitest";
import { CARD_STATES } from "./enums";
import { canTransition, TRANSITIONS } from "./state-machine";

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
