import { eq } from "drizzle-orm";
import { boards, cardDependencies, cardDocLinks, cards, db, docs, pool } from "@loopeng/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePlannerOutput, persistManagerDecomposition, PlannerOutputError } from "./decomposition.js";

function decompositionOutput(cardsSpec: object[], epicTitle = "Widget rollout"): string {
  const decomposition = {
    epic: { title: epicTitle, description: "Ship the widget end to end." },
    cards: cardsSpec,
  };
  return ["```markdown", "## Summary", "Ship a widget.", "```", "", "```json", JSON.stringify(decomposition), "```"].join("\n");
}

function cardSpec(overrides: object = {}) {
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

describe("persistManagerDecomposition", () => {
  let boardId: string;
  let specDocId: string;

  // Seeds the DB rows a real persistDecomposition run would have left behind
  // (epic card + spec doc + one relates_to'd child), without going through
  // doc-engine's git-backed createDoc — this test only needs a doc row to
  // exist to link against, not a real git-committed spec doc body.
  beforeAll(async () => {
    const [board] = await db.insert(boards).values({ name: "manager decomposition test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardId = board.id;

    const [doc] = await db
      .insert(docs)
      .values({ slug: `manager-test-spec-${Date.now()}`, title: "Widget rollout spec", docType: "wiki", repoPath: "wiki/manager-test-spec.md" })
      .returning({ id: docs.id });
    if (!doc) throw new Error("doc insert returned no row");
    specDocId = doc.id;
  });

  afterAll(async () => {
    await db.delete(boards).where(eq(boards.id, boardId));
    await db.delete(docs).where(eq(docs.id, specDocId));
    await pool.end();
  });

  async function seedEpic(cardsSpec: { key: string; title: string }[]) {
    const [epic] = await db
      .insert(cards)
      .values({ boardId, title: "Widget rollout", cardType: "epic", tags: ["planner-generated"] })
      .returning({ id: cards.id });
    if (!epic) throw new Error("epic insert returned no row");
    await db.insert(cardDocLinks).values({ cardId: epic.id, docId: specDocId, linkType: "spec" });

    const cardIds: string[] = [];
    for (const spec of cardsSpec) {
      const [card] = await db.insert(cards).values({ boardId, title: spec.title }).returning({ id: cards.id });
      if (!card) throw new Error("card insert returned no row");
      cardIds.push(card.id);
      await db.insert(cardDocLinks).values({ cardId: card.id, docId: specDocId, linkType: "spec" });
      await db.insert(cardDependencies).values({ cardId: card.id, dependsOnCardId: epic.id, dependencyType: "relates_to" });
    }

    return { epicCardId: epic.id, cardIds };
  }

  it("replaces the epic's child cards with the manager's adjusted breakdown", async () => {
    const original = await seedEpic([{ key: "a", title: "Original card" }]);

    const parsed = parsePlannerOutput(
      decompositionOutput([
        cardSpec({ key: "split-1", title: "Split part one", riskTier: "high" }),
        cardSpec({ key: "split-2", title: "Split part two", riskTier: "medium", dependsOn: ["split-1"] }),
      ]),
    );
    const result = await persistManagerDecomposition(original.epicCardId, parsed);

    expect(result.epicCardId).toBe(original.epicCardId);
    expect(result.cardIds).toHaveLength(2);
    expect(result.removedCardIds).toEqual(original.cardIds);

    const remainingOriginal = await db.select().from(cards).where(eq(cards.id, original.cardIds[0]!));
    expect(remainingOriginal).toHaveLength(0);

    const newCards = await db.select().from(cards).where(eq(cards.id, result.cardIds[0]!));
    expect(newCards[0]?.title).toBe("Split part one");

    const [epic] = await db.select().from(cards).where(eq(cards.id, original.epicCardId));
    expect(epic?.riskTier).toBe("high");

    const relatesToEdges = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, original.epicCardId));
    expect(relatesToEdges.map((e) => e.cardId).sort()).toEqual([...result.cardIds].sort());

    const specLinks = await db.select().from(cardDocLinks).where(eq(cardDocLinks.cardId, result.cardIds[0]!));
    expect(specLinks[0]?.linkType).toBe("spec");
    expect(specLinks[0]?.docId).toBe(specDocId);
  });

  it("leaves the breakdown effectively unchanged when the manager returns the same cards", async () => {
    const original = await seedEpic([{ key: "a", title: "Keep me" }]);
    const parsed = parsePlannerOutput(decompositionOutput([cardSpec({ key: "a", title: "Keep me" })]));

    const result = await persistManagerDecomposition(original.epicCardId, parsed);

    expect(result.removedCardIds).toEqual(original.cardIds);
    expect(result.cardIds).toHaveLength(1);
    const [newCard] = await db.select().from(cards).where(eq(cards.id, result.cardIds[0]!));
    expect(newCard?.title).toBe("Keep me");
  });

  it("throws when the epic card does not exist", async () => {
    const parsed = parsePlannerOutput(decompositionOutput([cardSpec()]));
    await expect(persistManagerDecomposition("00000000-0000-0000-0000-000000000000", parsed)).rejects.toThrow(PlannerOutputError);
  });

  it("throws when the card is not an epic", async () => {
    const original = await seedEpic([{ key: "a", title: "Not an epic child" }]);
    const parsed = parsePlannerOutput(decompositionOutput([cardSpec()]));
    await expect(persistManagerDecomposition(original.cardIds[0]!, parsed)).rejects.toThrow(/not an epic/);
  });
});
