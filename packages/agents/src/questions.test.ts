import { eq } from "drizzle-orm";
import { agentRoles, agentRuns, boards, cardDependencies, cards, db, pool } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { extractQuestion, resolveQuestionRouting } from "./questions.js";

describe("extractQuestion", () => {
  it("extracts the text following a QUESTION: marker", () => {
    const resultText = "I looked at the auth flow but I'm stuck.\n\nQUESTION: should sessions expire after 1h or 24h?";
    expect(extractQuestion(resultText)).toBe("should sessions expire after 1h or 24h?");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(extractQuestion("question:   what env?  ")).toBe("what env?");
  });

  it("returns null when there is no QUESTION: marker", () => {
    expect(extractQuestion("Implemented the feature and ran the tests, all green.")).toBeNull();
  });

  it("returns null when QUESTION: has no text after it", () => {
    expect(extractQuestion("QUESTION:   ")).toBeNull();
  });

  it("takes everything after the first marker, including newlines", () => {
    const resultText = "QUESTION: is this ambiguous requirement about\nauth or billing?";
    expect(extractQuestion(resultText)).toBe("is this ambiguous requirement about\nauth or billing?");
  });
});

describe("resolveQuestionRouting", () => {
  const boardIds: string[] = [];

  afterAll(async () => {
    for (const id of boardIds) {
      await db.delete(boards).where(eq(boards.id, id));
    }
    await pool.end();
  });

  async function makeBoard() {
    const [board] = await db.insert(boards).values({ name: "question-routing test board" }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    boardIds.push(board.id);
    return board.id;
  }

  it("routes to product_owner for a card with no epic", async () => {
    const bId = await makeBoard();
    const [card] = await db.insert(cards).values({ boardId: bId, title: "standalone card" }).returning({ id: cards.id });
    expect(await resolveQuestionRouting(card!.id)).toBe("product_owner");
  });

  it("routes to product_owner when the epic has no successful tech-manager run", async () => {
    const bId = await makeBoard();
    const [epic] = await db.insert(cards).values({ boardId: bId, title: "epic", cardType: "epic" }).returning({ id: cards.id });
    const [child] = await db.insert(cards).values({ boardId: bId, title: "child" }).returning({ id: cards.id });
    await db.insert(cardDependencies).values({ cardId: child!.id, dependsOnCardId: epic!.id, dependencyType: "relates_to" });

    expect(await resolveQuestionRouting(child!.id)).toBe("product_owner");
  });

  it("routes to tech-manager once the epic has a successful tech-manager run", async () => {
    const bId = await makeBoard();
    const [epic] = await db.insert(cards).values({ boardId: bId, title: "epic", cardType: "epic" }).returning({ id: cards.id });
    const [child] = await db.insert(cards).values({ boardId: bId, title: "child" }).returning({ id: cards.id });
    await db.insert(cardDependencies).values({ cardId: child!.id, dependsOnCardId: epic!.id, dependencyType: "relates_to" });

    const [role] = await db.select().from(agentRoles).where(eq(agentRoles.name, "tech-manager"));
    if (!role) throw new Error("tech-manager role not seeded");
    await db.insert(agentRuns).values({ cardId: epic!.id, agentRoleId: role.id, status: "succeeded" });

    expect(await resolveQuestionRouting(child!.id)).toBe("tech-manager");
  });

  it("does not route to tech-manager when the run failed", async () => {
    const bId = await makeBoard();
    const [epic] = await db.insert(cards).values({ boardId: bId, title: "epic", cardType: "epic" }).returning({ id: cards.id });
    const [child] = await db.insert(cards).values({ boardId: bId, title: "child" }).returning({ id: cards.id });
    await db.insert(cardDependencies).values({ cardId: child!.id, dependsOnCardId: epic!.id, dependencyType: "relates_to" });

    const [role] = await db.select().from(agentRoles).where(eq(agentRoles.name, "tech-manager"));
    if (!role) throw new Error("tech-manager role not seeded");
    await db.insert(agentRuns).values({ cardId: epic!.id, agentRoleId: role.id, status: "failed" });

    expect(await resolveQuestionRouting(child!.id)).toBe("product_owner");
  });
});
