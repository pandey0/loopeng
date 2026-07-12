import { describe, expect, it } from "vitest";
import { matchCriterionVerdicts, parseCriterionVerdicts } from "./criterion-verdicts";

describe("parseCriterionVerdicts", () => {
  it("parses a real multi-criterion reviewer transcript", () => {
    const text = [
      "Reviewed the diff against every acceptance criterion.",
      "",
      "CRITERION: Card detail view displays the card's current column name. -> SATISFIED",
      "CRITERION: Label text matches the column label shown on the board (no naming drift). -> SATISFIED",
      "CRITERION: Status shown reflects the latest value on page open/refetch. -> NOT SATISFIED",
      "",
      "VERDICT: FAIL",
    ].join("\n");

    expect(parseCriterionVerdicts(text)).toEqual([
      { criterion: "Card detail view displays the card's current column name.", satisfied: true },
      { criterion: "Label text matches the column label shown on the board (no naming drift).", satisfied: true },
      { criterion: "Status shown reflects the latest value on page open/refetch.", satisfied: false },
    ]);
  });

  it("returns an empty array when there are no CRITERION lines", () => {
    expect(parseCriterionVerdicts("VERDICT: PASS\nLooks good.")).toEqual([]);
  });

  it("is tolerant of extra whitespace around the arrow", () => {
    expect(parseCriterionVerdicts("CRITERION: does the thing   ->    SATISFIED")).toEqual([
      { criterion: "does the thing", satisfied: true },
    ]);
  });
});

describe("matchCriterionVerdicts", () => {
  it("matches by exact text and returns satisfied per criterion", () => {
    const result = matchCriterionVerdicts(
      ["Reads the file", "Writes the file"],
      [
        { criterion: "Reads the file", satisfied: true },
        { criterion: "Writes the file", satisfied: false },
      ],
    );
    expect(result).toEqual([
      { criterion: "Reads the file", satisfied: true },
      { criterion: "Writes the file", satisfied: false },
    ]);
  });

  it("returns null (not yet verified) for a criterion with no matching CRITERION line", () => {
    const result = matchCriterionVerdicts(["A criterion the reviewer never mentioned"], []);
    expect(result).toEqual([{ criterion: "A criterion the reviewer never mentioned", satisfied: null }]);
  });
});
