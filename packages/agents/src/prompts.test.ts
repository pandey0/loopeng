import { describe, expect, it } from "vitest";
import type { cards } from "@loopeng/db";
import { buildDesignerReviewPrompt, buildDesignerSpecPrompt, buildImplementerPrompt, buildPlannerPrompt, buildReviewerPrompt } from "./prompts";

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

  it("includes linked spec doc bodies", () => {
    const prompt = buildImplementerPrompt(card(), [], undefined, [
      { title: "Auth Spec", body: "All requests must be authenticated." },
    ]);
    expect(prompt).toContain("## Linked spec docs");
    expect(prompt).toContain("### Spec: Auth Spec");
    expect(prompt).toContain("All requests must be authenticated.");
  });

  it("documents the QUESTION: escalation convention", () => {
    const prompt = buildImplementerPrompt(card(), []);
    expect(prompt).toContain("QUESTION: <your question>");
  });

  it("omits the Q&A section when there are no answered questions", () => {
    const prompt = buildImplementerPrompt(card(), []);
    expect(prompt).not.toContain("## Previous questions & answers");
  });

  it("injects previously answered questions into the prompt", () => {
    const prompt = buildImplementerPrompt(card(), [], undefined, [], [
      { question: "should sessions expire after 1h or 24h?", answer: "24h" },
    ]);
    expect(prompt).toContain("## Previous questions & answers");
    expect(prompt).toContain("Previously asked: should sessions expire after 1h or 24h?");
    expect(prompt).toContain("Answer: 24h");
  });
});

describe("buildPlannerPrompt", () => {
  it("includes the product owner request and json schema fields", () => {
    const prompt = buildPlannerPrompt("Add SSO login for enterprise customers");
    expect(prompt).toContain("Add SSO login for enterprise customers");
    expect(prompt).toContain('"epic"');
    expect(prompt).toContain('"dependsOn"');
    expect(prompt).toContain("```markdown");
    expect(prompt).toContain("```json");
  });

  it("lists existing open card titles to avoid duplication", () => {
    const prompt = buildPlannerPrompt("Add SSO login", ["Existing OAuth card"]);
    expect(prompt).toContain("- Existing OAuth card");
  });

  it("notes when there are no existing cards", () => {
    const prompt = buildPlannerPrompt("Add SSO login", []);
    expect(prompt).toContain("(none)");
  });
});

describe("buildReviewerPrompt", () => {
  it("lists acceptance criteria alongside the diff", () => {
    const prompt = buildReviewerPrompt(card({ acceptanceCriteria: ["handles empty state"] }), "diff --git a/x b/x");
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain("- handles empty state");
  });

  it("requires per-criterion SATISFIED/NOT SATISFIED enumeration for each acceptance criterion", () => {
    const criteria = ["handles empty state", "shows loading spinner", "logs errors to console"];
    const prompt = buildReviewerPrompt(card({ acceptanceCriteria: criteria }), "diff --git a/x b/x");

    expect(prompt).toContain("exactly 3 CRITERION line(s)");
    for (const c of criteria) {
      expect(prompt).toContain(c);
    }
    expect(prompt).toContain("CRITERION: <the exact criterion text> -> SATISFIED");
    expect(prompt).toContain("CRITERION: <the exact criterion text> -> NOT SATISFIED");
    expect(prompt).toContain("If any CRITERION line is marked NOT SATISFIED, the final verdict must be VERDICT: FAIL.");
  });

  it("includes linked spec doc bodies", () => {
    const prompt = buildReviewerPrompt(card({ acceptanceCriteria: ["handles empty state"] }), "diff --git a/x b/x", [
      { title: "Auth Spec", body: "All requests must be authenticated." },
    ]);
    expect(prompt).toContain("## Linked spec docs");
    expect(prompt).toContain("### Spec: Auth Spec");
    expect(prompt).toContain("All requests must be authenticated.");
  });
});

describe("buildDesignerSpecPrompt", () => {
  it("lists each acceptance criterion", () => {
    const prompt = buildDesignerSpecPrompt(card({ acceptanceCriteria: ["shows the widget"] }));
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain("- shows the widget");
  });

  it("asks for reuse of existing packages/ui components and tokens", () => {
    const prompt = buildDesignerSpecPrompt(card());
    expect(prompt).toContain("packages/ui components and design tokens to reuse");
  });

  it("asks for interaction states and accessibility notes", () => {
    const prompt = buildDesignerSpecPrompt(card());
    expect(prompt).toContain("loading, empty, and error");
    expect(prompt).toContain("accessibility notes");
  });

  it("requires a single fenced markdown block", () => {
    const prompt = buildDesignerSpecPrompt(card());
    expect(prompt).toContain("```markdown");
  });

  it("is read-only, disallowing edit/write/shell", () => {
    const prompt = buildDesignerSpecPrompt(card());
    expect(prompt).toContain("cannot edit, write, or run shell commands");
  });
});

describe("buildDesignerReviewPrompt", () => {
  it("includes the diff to review", () => {
    const prompt = buildDesignerReviewPrompt(card(), "diff --git a/x b/x");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("checks token usage, component reuse, and accessibility regressions", () => {
    const prompt = buildDesignerReviewPrompt(card(), "diff --git a/x b/x");
    expect(prompt).toContain("Design-system token usage vs hardcoded style values");
    expect(prompt).toContain("Component reuse vs one-off markup");
    expect(prompt).toContain("responsive or accessibility regressions");
  });

  it("includes linked spec doc bodies", () => {
    const prompt = buildDesignerReviewPrompt(card(), "diff --git a/x b/x", [
      { title: "Design Spec", body: "Use the Button component from packages/ui." },
    ]);
    expect(prompt).toContain("## Linked spec docs");
    expect(prompt).toContain("### Spec: Design Spec");
    expect(prompt).toContain("Use the Button component from packages/ui.");
  });

  it("ends with the VERDICT convention", () => {
    const prompt = buildDesignerReviewPrompt(card(), "diff --git a/x b/x");
    expect(prompt).toContain("VERDICT: PASS");
    expect(prompt).toContain("VERDICT: FAIL");
  });
});
