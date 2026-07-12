import { describe, expect, it } from "vitest";
import { distillFailureNote, isRateLimitError, parseRateLimitResetAt } from "./failure-note.js";

describe("distillFailureNote", () => {
  it("caps the note at 10 lines even for a huge rejection transcript", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}: some reviewer reasoning about the diff`).join("\n");
    const note = distillFailureNote("review_rejected", huge);
    expect(note.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("pulls out NOT SATISFIED criterion lines ahead of generic narrative", () => {
    const text = [
      "I looked at the diff carefully and thought about many things.",
      "CRITERION: shows the widget -> SATISFIED",
      "CRITERION: widget is clickable -> NOT SATISFIED",
      "some more narrative that isn't load-bearing",
      "VERDICT: FAIL",
    ].join("\n");
    const note = distillFailureNote("review_rejected", text);
    expect(note).toContain("CRITERION: widget is clickable -> NOT SATISFIED");
    expect(note).not.toContain("CRITERION: shows the widget -> SATISFIED");
    expect(note).toContain("VERDICT: FAIL");
  });

  it("falls back to the tail of the transcript when there are no CRITERION lines", () => {
    const text = ["some setup output", "a stack trace line", "Error: something crashed"].join("\n");
    const note = distillFailureNote("implementer_error", text);
    expect(note).toContain("Implementer run failed.");
    expect(note).toContain("Error: something crashed");
  });

  it("truncates any single overly-long line", () => {
    const longLine = "x".repeat(1000);
    const note = distillFailureNote("implementer_error", longLine);
    const bodyLine = note.split("\n")[1];
    expect(bodyLine?.length).toBeLessThan(350);
  });
});

describe("isRateLimitError", () => {
  it("recognizes the real Claude CLI session-limit message", () => {
    expect(isRateLimitError("You've hit your session limit · resets 1:40am (Asia/Kolkata)")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRateLimitError("RATE LIMIT exceeded, try again later")).toBe(true);
  });

  it("is false for a genuine implementer crash", () => {
    expect(isRateLimitError("TypeError: cannot read property 'foo' of undefined")).toBe(false);
  });

  it("is false for a genuine review rejection", () => {
    expect(isRateLimitError("VERDICT: FAIL\nCRITERION: handles null email -> NOT SATISFIED")).toBe(false);
  });
});

// Asia/Kolkata has a fixed UTC+5:30 offset (no DST), which makes these exact
// -- picking a DST-observing zone would make the expected UTC instant depend
// on which side of a transition referenceTime falls on.
describe("parseRateLimitResetAt", () => {
  it("resolves today's occurrence when the reset clock time is still ahead of referenceTime", () => {
    // referenceTime = 2026-07-13T00:30 IST -- 1:40am IST that same day is
    // still ahead of it.
    const referenceTime = new Date("2026-07-12T19:00:00.000Z");
    const resetAt = parseRateLimitResetAt("You've hit your session limit · resets 1:40am (Asia/Kolkata)", referenceTime);
    expect(resetAt?.toISOString()).toBe("2026-07-12T20:10:00.000Z");
  });

  it("rolls over to tomorrow's occurrence once the reset clock time has already passed", () => {
    // referenceTime = 2026-07-13T02:30 IST -- 1:40am IST that day already
    // passed, so the next real occurrence is the following day.
    const referenceTime = new Date("2026-07-12T21:00:00.000Z");
    const resetAt = parseRateLimitResetAt("You've hit your session limit · resets 1:40am (Asia/Kolkata)", referenceTime);
    expect(resetAt?.toISOString()).toBe("2026-07-13T20:10:00.000Z");
  });

  it("returns null when the text has no recognizable reset clause", () => {
    expect(parseRateLimitResetAt("TypeError: cannot read property 'foo' of undefined")).toBeNull();
  });

  it("returns null when the timezone name isn't real, instead of throwing", () => {
    expect(parseRateLimitResetAt("You've hit your session limit · resets 1:40am (Not/AZone)")).toBeNull();
  });
});
