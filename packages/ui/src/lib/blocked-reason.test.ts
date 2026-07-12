import { describe, expect, it } from "vitest";
import { isAutoRetrying, isHumanBlocked } from "./blocked-reason";

describe("isHumanBlocked", () => {
  it("is true for a question-escalation blockedReason", () => {
    expect(isHumanBlocked("waiting on answer: which auth provider should this use?")).toBe(true);
  });

  it("is false for a gate-failure blockedReason", () => {
    expect(isHumanBlocked("security_scan failed")).toBe(false);
  });

  it("is false for a reviewer-rejection blockedReason", () => {
    expect(isHumanBlocked("reviewer rejected")).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(isHumanBlocked(null)).toBe(false);
    expect(isHumanBlocked(undefined)).toBe(false);
  });
});

describe("isAutoRetrying", () => {
  it("is true for the exact restart-orphan reason reconcile.ts writes", () => {
    expect(isAutoRetrying('implementer run interrupted (stuck in "running" at boot -- likely an api restart mid-run)')).toBe(true);
  });

  it("is false for a gate failure -- that needs an actual fix, not a timer", () => {
    expect(isAutoRetrying("security_scan failed")).toBe(false);
  });

  it("is false for a question escalation", () => {
    expect(isAutoRetrying("waiting on answer: which auth provider should this use?")).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(isAutoRetrying(null)).toBe(false);
    expect(isAutoRetrying(undefined)).toBe(false);
  });
});
