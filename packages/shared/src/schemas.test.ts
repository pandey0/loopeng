import { describe, expect, it } from "vitest";
import { CardCreateInputSchema, CardSchema, CardUpdateInputSchema } from "./schemas";

describe("CardSchema", () => {
  it("defaults acceptanceCriteria to an empty array", () => {
    const card = CardSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      description: null,
      assigneeId: null,
      agentRoleId: null,
      worktreeId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(card.acceptanceCriteria).toEqual([]);
  });

  it("accepts a list of acceptance criteria strings", () => {
    const card = CardSchema.parse({
      id: "11111111-1111-1111-1111-111111111111",
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      description: null,
      assigneeId: null,
      agentRoleId: null,
      worktreeId: null,
      acceptanceCriteria: ["shows the title", "shows acceptance criteria"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(card.acceptanceCriteria).toEqual(["shows the title", "shows acceptance criteria"]);
  });
});

describe("CardCreateInputSchema", () => {
  it("accepts acceptanceCriteria on create", () => {
    const input = CardCreateInputSchema.parse({
      boardId: "22222222-2222-2222-2222-222222222222",
      title: "Some card",
      acceptanceCriteria: ["criterion 1"],
      specDocId: "33333333-3333-3333-3333-333333333333",
    });
    expect(input.acceptanceCriteria).toEqual(["criterion 1"]);
  });

  it("rejects card creation with no spec doc linked", () => {
    expect(() =>
      CardCreateInputSchema.parse({
        boardId: "22222222-2222-2222-2222-222222222222",
        title: "Some card",
      }),
    ).toThrow();
  });
});

describe("CardUpdateInputSchema", () => {
  it("accepts a partial update with only acceptanceCriteria", () => {
    const input = CardUpdateInputSchema.parse({ acceptanceCriteria: ["a", "b"] });
    expect(input).toEqual({ acceptanceCriteria: ["a", "b"] });
  });

  it("accepts a partial update with only title", () => {
    const input = CardUpdateInputSchema.parse({ title: "Renamed" });
    expect(input).toEqual({ title: "Renamed" });
  });

  it("rejects an empty update", () => {
    expect(() => CardUpdateInputSchema.parse({})).toThrow();
  });

  it("rejects an unknown card type", () => {
    expect(() => CardUpdateInputSchema.parse({ cardType: "not-a-real-type" })).toThrow();
  });
});
