import { describe, expect, it } from "vitest";
import { filterCardsByTitle, hasNoMatches } from "./titleSearch";

const cards = [{ title: "Fix login bug" }, { title: "Add dashboard widget" }, { title: "Refactor DASHBOARD api" }];

describe("filterCardsByTitle", () => {
  it("returns all cards when the query is empty", () => {
    expect(filterCardsByTitle(cards, "")).toEqual(cards);
  });

  it("returns all cards when the query is only whitespace", () => {
    expect(filterCardsByTitle(cards, "   ")).toEqual(cards);
  });

  it("matches case-insensitively as a substring of the title", () => {
    expect(filterCardsByTitle(cards, "dashboard")).toEqual([cards[1], cards[2]]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(filterCardsByTitle(cards, "  dashboard  ")).toEqual([cards[1], cards[2]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterCardsByTitle(cards, "zzz-no-such-card")).toEqual([]);
  });
});

describe("hasNoMatches", () => {
  it("is false with no query, even if visibleCards is empty", () => {
    expect(hasNoMatches("", [])).toBe(false);
  });

  it("is true once a query matches nothing", () => {
    expect(hasNoMatches("zzz-no-such-card", [])).toBe(true);
  });

  it("clears as soon as the query is cleared", () => {
    expect(hasNoMatches("", cards)).toBe(false);
  });

  it("clears as soon as the query is edited to something that matches", () => {
    expect(hasNoMatches("dashboard", [cards[1]])).toBe(false);
  });
});
