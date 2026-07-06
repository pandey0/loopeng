import { describe, expect, it } from "vitest";
import type { cards } from "@loopeng/db";
import { buildImplementerPrompt, buildPlannerPrompt, buildReviewerPrompt } from "./prompts";

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

  it("includes linked spec docs as a slug + one-line summary, not the full body", () => {
    const prompt = buildImplementerPrompt(card(), [], undefined, [
      { slug: "auth-spec", title: "Auth Spec", summary: "All requests must be authenticated." },
    ]);
    expect(prompt).toContain("## Linked spec docs");
    expect(prompt).toContain("`auth-spec`");
    expect(prompt).toContain("Auth Spec");
    expect(prompt).toContain("All requests must be authenticated.");
  });

  it("tells the agent how to fetch a doc's full text via get_doc", () => {
    const prompt = buildImplementerPrompt(card(), []);
    expect(prompt).toContain("get_doc");
    expect(prompt).toContain('{ "slug": "<slug>" }');
  });

  it("lists relevant skill docs as a slug + one-line summary", () => {
    const prompt = buildImplementerPrompt(card(), [{ slug: "retry-etiquette", title: "Retry Etiquette", summary: "Keep retries idempotent." }]);
    expect(prompt).toContain("## Relevant skill docs");
    expect(prompt).toContain("`retry-etiquette`");
    expect(prompt).toContain("Keep retries idempotent.");
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

// Deterministic, diff-visible proof for the "measured prompt size for a
// doc-linked card drops versus the inline-everything baseline" acceptance
// criterion on rfc/2026-07-obsidian-vault-token-efficiency — same comparison
// packages/orchestrator/src/scripts/measure-prompt-size.ts records live
// against the real dev DB/vault, but expressed as a fixture-based unit test
// so the reduction is asserted on every CI run, not just a one-off script.
describe("prompt size reduction (doc-linked card, old inline-full-body vs new summary+slug)", () => {
  function oldStyleSpecDocsBlock(fullDocs: { title: string; body: string }[]): string {
    return fullDocs.map((d) => `### Spec: ${d.title}\n${d.body}`).join("\n\n");
  }

  // Representative full ADR/RFC-length body (real linked docs in the vault
  // run well into the low thousands of characters — see adr/0002 and the
  // RFC in data/wiki-repo).
  const fullBody = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i}: real spec/ADR prose describing context, decision, and consequences in detail.`,
  ).join("\n\n");

  const fullDocs = [
    { title: "Doc One", body: fullBody },
    { title: "Doc Two", body: fullBody },
    { title: "Doc Three", body: fullBody },
  ];
  const summaryDocs = [
    { slug: "doc-one", title: "Doc One", summary: "One-line summary of doc one." },
    { slug: "doc-two", title: "Doc Two", summary: "One-line summary of doc two." },
    { slug: "doc-three", title: "Doc Three", summary: "One-line summary of doc three." },
  ];

  it("shrinks the spec-docs section of the implementer prompt by a large margin", () => {
    const oldPrompt = buildImplementerPrompt(card(), [], undefined, []).replace(
      "(no linked spec docs found)",
      oldStyleSpecDocsBlock(fullDocs),
    );
    const newPrompt = buildImplementerPrompt(card(), [], undefined, summaryDocs);

    expect(newPrompt.length).toBeLessThan(oldPrompt.length);
    const reductionPct = 1 - newPrompt.length / oldPrompt.length;
    expect(reductionPct).toBeGreaterThan(0.5);
  });

  it("shrinks the spec-docs section of the reviewer prompt by a large margin", () => {
    const diff = "diff --git a/x b/x";
    const oldPrompt = buildReviewerPrompt(card(), diff, []).replace(
      "(no linked spec docs found)",
      oldStyleSpecDocsBlock(fullDocs),
    );
    const newPrompt = buildReviewerPrompt(card(), diff, summaryDocs);

    expect(newPrompt.length).toBeLessThan(oldPrompt.length);
    const reductionPct = 1 - newPrompt.length / oldPrompt.length;
    expect(reductionPct).toBeGreaterThan(0.5);
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

  it("includes existing spec docs and skill docs as slug + one-line summary, not full body", () => {
    const prompt = buildPlannerPrompt("Add SSO login", [], [
      { slug: "auth-rfc", title: "Auth RFC", summary: "Describes the SSO federation approach." },
    ], [
      { slug: "retry-etiquette", title: "Retry Etiquette", summary: "Keep retries idempotent." },
    ]);
    expect(prompt).toContain("## Existing spec docs");
    expect(prompt).toContain("`auth-rfc`");
    expect(prompt).toContain("Describes the SSO federation approach.");
    expect(prompt).toContain("## Existing skill docs");
    expect(prompt).toContain("`retry-etiquette`");
    expect(prompt).toContain("get_doc");
  });

  it("notes when there are no spec/skill docs", () => {
    const prompt = buildPlannerPrompt("Add SSO login", []);
    expect(prompt).toContain("(no linked spec docs found)");
    expect(prompt).toContain("(no relevant skill docs found)");
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

  it("includes linked spec docs as a slug + one-line summary, not the full body", () => {
    const prompt = buildReviewerPrompt(card({ acceptanceCriteria: ["handles empty state"] }), "diff --git a/x b/x", [
      { slug: "auth-spec", title: "Auth Spec", summary: "All requests must be authenticated." },
    ]);
    expect(prompt).toContain("## Linked spec docs");
    expect(prompt).toContain("`auth-spec`");
    expect(prompt).toContain("All requests must be authenticated.");
  });
});
