import { describe, expect, it } from "vitest";
import {
  computeEpicRiskTier,
  findDependencyCycle,
  parsePlannerOutput,
  PlannerOutputError,
  type PlannerCardSpec,
} from "./decomposition.js";

function cardSpec(overrides: Partial<PlannerCardSpec> = {}): PlannerCardSpec {
  return {
    key: "card-a",
    title: "Do the thing",
    description: "Does the thing.",
    cardType: "feature",
    riskTier: "low",
    priority: 3,
    tags: [],
    acceptanceCriteria: ["it does the thing"],
    dependsOn: [],
    ...overrides,
  };
}

function validOutput(overrides: { cards?: PlannerCardSpec[] } = {}): string {
  const decomposition = {
    epic: { title: "Widget rollout", description: "Ship the widget end to end." },
    cards: overrides.cards ?? [cardSpec()],
  };
  return [
    "```markdown",
    "## Summary",
    "Ship a widget.",
    "```",
    "",
    "```json",
    JSON.stringify(decomposition),
    "```",
  ].join("\n");
}

describe("parsePlannerOutput", () => {
  it("parses a well-formed spec + decomposition pair", () => {
    const { specBody, decomposition } = parsePlannerOutput(validOutput());
    expect(specBody).toContain("## Summary");
    expect(decomposition.epic.title).toBe("Widget rollout");
    expect(decomposition.cards).toHaveLength(1);
  });

  it("throws when the markdown spec block is missing", () => {
    const output = ["```json", JSON.stringify({ epic: { title: "x", description: "y" }, cards: [cardSpec()] }), "```"].join("\n");
    expect(() => parsePlannerOutput(output)).toThrow(PlannerOutputError);
  });

  it("throws when the json decomposition block is missing", () => {
    const output = ["```markdown", "## Summary", "```"].join("\n");
    expect(() => parsePlannerOutput(output)).toThrow(PlannerOutputError);
  });

  it("throws on invalid JSON in the decomposition block", () => {
    const output = ["```markdown", "## Summary", "```", "", "```json", "{not valid json", "```"].join("\n");
    expect(() => parsePlannerOutput(output)).toThrow(PlannerOutputError);
  });

  it("throws when the decomposition fails schema validation", () => {
    const output = ["```markdown", "## Summary", "```", "", "```json", JSON.stringify({ epic: { title: "x" }, cards: [] }), "```"].join(
      "\n",
    );
    expect(() => parsePlannerOutput(output)).toThrow(PlannerOutputError);
  });

  it("throws on duplicate card keys", () => {
    const output = validOutput({ cards: [cardSpec({ key: "a" }), cardSpec({ key: "a", title: "Other" })] });
    expect(() => parsePlannerOutput(output)).toThrow(/duplicate card keys/);
  });

  it("throws when a card depends on itself", () => {
    const output = validOutput({ cards: [cardSpec({ key: "a", dependsOn: ["a"] })] });
    expect(() => parsePlannerOutput(output)).toThrow(/cannot depend on itself/);
  });

  it("throws when a card depends on an unknown key", () => {
    const output = validOutput({ cards: [cardSpec({ key: "a", dependsOn: ["ghost"] })] });
    expect(() => parsePlannerOutput(output)).toThrow(/unknown key/);
  });

  it("throws when the dependency graph has a cycle", () => {
    const output = validOutput({
      cards: [cardSpec({ key: "a", dependsOn: ["b"] }), cardSpec({ key: "b", dependsOn: ["a"] })],
    });
    expect(() => parsePlannerOutput(output)).toThrow(/dependency cycle/);
  });

  it("rejects a leaf card typed as epic", () => {
    const decomposition = {
      epic: { title: "x", description: "y" },
      cards: [{ ...cardSpec(), cardType: "epic" }],
    };
    const output = ["```markdown", "## Summary", "```", "", "```json", JSON.stringify(decomposition), "```"].join("\n");
    expect(() => parsePlannerOutput(output)).toThrow(PlannerOutputError);
  });
});

describe("findDependencyCycle", () => {
  it("returns null for an acyclic graph", () => {
    const cards = [cardSpec({ key: "a", dependsOn: ["b"] }), cardSpec({ key: "b", dependsOn: [] })];
    expect(findDependencyCycle(cards)).toBeNull();
  });

  it("finds a two-node cycle", () => {
    const cards = [cardSpec({ key: "a", dependsOn: ["b"] }), cardSpec({ key: "b", dependsOn: ["a"] })];
    expect(findDependencyCycle(cards)).toEqual(["a", "b", "a"]);
  });

  it("finds a longer transitive cycle", () => {
    const cards = [
      cardSpec({ key: "a", dependsOn: ["b"] }),
      cardSpec({ key: "b", dependsOn: ["c"] }),
      cardSpec({ key: "c", dependsOn: ["a"] }),
    ];
    expect(findDependencyCycle(cards)).toEqual(["a", "b", "c", "a"]);
  });
});

describe("computeEpicRiskTier", () => {
  it("returns low when every card is low risk", () => {
    expect(computeEpicRiskTier([cardSpec({ riskTier: "low" }), cardSpec({ key: "b", riskTier: "low" })])).toBe("low");
  });

  it("returns the highest risk tier among the cards", () => {
    const cards = [cardSpec({ riskTier: "low" }), cardSpec({ key: "b", riskTier: "high" }), cardSpec({ key: "c", riskTier: "medium" })];
    expect(computeEpicRiskTier(cards)).toBe("high");
  });
});
