import { describe, expect, it } from "vitest";
import { extractQuestion } from "./questions.js";

describe("extractQuestion", () => {
  it("extracts the text following a QUESTION: marker", () => {
    const resultText = "I looked at the auth flow but I'm stuck.\n\nQUESTION: should sessions expire after 1h or 24h?";
    expect(extractQuestion(resultText)).toBe("should sessions expire after 1h or 24h?");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(extractQuestion("question:   what env?  ")).toBe("what env?");
  });

  it("returns null when there is no QUESTION: marker", () => {
    expect(extractQuestion("Implemented the feature and ran the tests, all green.")).toBeNull();
  });

  it("returns null when QUESTION: has no text after it", () => {
    expect(extractQuestion("QUESTION:   ")).toBeNull();
  });

  it("takes everything after the first marker, including newlines", () => {
    const resultText = "QUESTION: is this ambiguous requirement about\nauth or billing?";
    expect(extractQuestion(resultText)).toBe("is this ambiguous requirement about\nauth or billing?");
  });
});
