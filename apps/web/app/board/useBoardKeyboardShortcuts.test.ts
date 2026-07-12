import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./useBoardKeyboardShortcuts";

describe("isTypingTarget", () => {
  it("is false with no target", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("is true for an input, so '/' doesn't steal focus while already typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
  });

  it("is true for a textarea", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
  });

  it("is false for a plain element, so '/' anywhere else focuses the search box", () => {
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
  });
});
