import { describe, expect, it } from "vitest";
import { isHumanBlocked } from "./blocked-reason";

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
