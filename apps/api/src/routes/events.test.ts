import { describe, expect, it } from "vitest";
import { matchesBoard } from "./events.js";

type EventRow = Parameters<typeof matchesBoard>[0];

function event(overrides: Partial<EventRow>): EventRow {
  return {
    id: 1,
    entityType: "card",
    entityId: "card-1",
    eventType: "card.moved",
    actorType: "user",
    actorId: null,
    payload: {},
    createdAt: new Date(),
    ...overrides,
  } as EventRow;
}

describe("matchesBoard", () => {
  it("matches a card event whose entity id is one of the board's cards", () => {
    expect(matchesBoard(event({ entityType: "card", entityId: "card-1" }), ["card-1", "card-2"])).toBe(true);
  });

  it("rejects a card event for a card on a different board", () => {
    expect(matchesBoard(event({ entityType: "card", entityId: "card-9" }), ["card-1", "card-2"])).toBe(false);
  });

  it("matches a doc event via payload.cardId", () => {
    const row = event({ entityType: "doc", entityId: "doc-1", eventType: "doc.drift_detected", payload: { cardId: "card-2" } });
    expect(matchesBoard(row, ["card-1", "card-2"])).toBe(true);
  });

  it("rejects a doc event whose payload.cardId is missing", () => {
    const row = event({ entityType: "doc", entityId: "doc-1", eventType: "doc.drift_detected", payload: {} });
    expect(matchesBoard(row, ["card-1", "card-2"])).toBe(false);
  });

  it("rejects entity types with no known board linkage", () => {
    expect(matchesBoard(event({ entityType: "worktree", entityId: "wt-1" }), ["card-1"])).toBe(false);
  });
});
