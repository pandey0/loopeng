import { describe, expect, it } from "vitest";
import { computeStaleDocs, type StaleDocCandidateRow } from "./drift.js";

function row(overrides: Partial<StaleDocCandidateRow>): StaleDocCandidateRow {
  return {
    docId: "doc-1",
    slug: "some-doc",
    title: "Some Doc",
    docType: "wiki",
    docUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    cardId: "card-1",
    cardTitle: "Some Card",
    cardUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    skillLastVerifiedAt: null,
    ...overrides,
  };
}

describe("computeStaleDocs", () => {
  it("flags a doc whose linked card shipped after the doc was last updated", () => {
    const stale = computeStaleDocs([
      row({ docUpdatedAt: new Date("2026-01-01"), cardUpdatedAt: new Date("2026-02-01") }),
    ]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ docId: "doc-1", cardId: "card-1" });
  });

  it("does not flag a doc that was updated after the card shipped", () => {
    const stale = computeStaleDocs([
      row({ docUpdatedAt: new Date("2026-03-01"), cardUpdatedAt: new Date("2026-02-01") }),
    ]);
    expect(stale).toHaveLength(0);
  });

  it("uses skills.lastVerifiedAt instead of docUpdatedAt for skill docs", () => {
    const rows = [
      row({
        docType: "skill",
        docUpdatedAt: new Date("2026-01-01"),
        skillLastVerifiedAt: new Date("2026-03-01"),
        cardUpdatedAt: new Date("2026-02-01"),
      }),
    ];
    expect(computeStaleDocs(rows)).toHaveLength(0);
  });

  it("flags a skill doc verified before the card shipped even if the doc row itself is recent", () => {
    const rows = [
      row({
        docType: "skill",
        docUpdatedAt: new Date("2026-03-01"),
        skillLastVerifiedAt: new Date("2026-01-01"),
        cardUpdatedAt: new Date("2026-02-01"),
      }),
    ];
    expect(computeStaleDocs(rows)).toHaveLength(1);
  });

  it("returns nothing for an empty input", () => {
    expect(computeStaleDocs([])).toEqual([]);
  });
});
