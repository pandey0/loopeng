import { describe, expect, it } from "vitest";
import type { cards } from "@loopeng/db";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompts";

type Card = typeof cards.$inferSelect;

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    boardId: "board-1",
    title: "Add widget",
    description: "Adds a widget to the dashboard.",
    cardType: "feature",
    state: "in_progress",
    riskTier: "low",
    touchesArchitecture: false,
    priority: 3,
    tags: [],
    acceptanceCriteria: [],
    assigneeId: null,
    agentRoleId: null,
    worktreeId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildImplementerPrompt", () => {
  it("lists each acceptance criterion", () => {
    const prompt = buildImplementerPrompt(
      card({ acceptanceCriteria: ["shows the widget", "widget is clickable"] }),
      [],
    );
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain("- shows the widget");
    expect(prompt).toContain("- widget is clickable");
  });

  it("notes when no acceptance criteria are specified", () => {
    const prompt = buildImplementerPrompt(card({ acceptanceCriteria: [] }), []);
    expect(prompt).toContain("(none specified)");
  });
});

describe("buildReviewerPrompt", () => {
  it("lists acceptance criteria alongside the diff", () => {
    const prompt = buildReviewerPrompt(card({ acceptanceCriteria: ["handles empty state"] }), "diff --git a/x b/x");
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain("- handles empty state");
  });
});
