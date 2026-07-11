import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { advanceCardState, CardNotFoundError, InvalidTransitionError, TerminalColumnError } from "./state-machine.js";

describe("advanceCardState", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    await pool.end();
  });

  async function makeCard(title: string, state: string) {
    const [project] = await db.insert(projects).values({ name: `${title} project`, repoPath: "/tmp/does-not-matter" }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `${title} board`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  it("moves a card to the next column in the ordered list, writing through applyTransition", async () => {
    const cardId = await makeCard("advance: ready card", "ready");

    const updated = await advanceCardState({ cardId, actorType: "user" });

    expect(updated.state).toBe("in_progress");
    expect(updated.updatedAt).toBeInstanceOf(Date);

    const movedEvents = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.entityId, cardId));
    expect(movedEvents.some((e) => e.eventType === "card.moved")).toBe(true);
  });

  it("rejects advancing a card already in the terminal column (done) with a TerminalColumnError", async () => {
    const cardId = await makeCard("advance: done card", "done");

    await expect(advanceCardState({ cardId, actorType: "user" })).rejects.toThrow(TerminalColumnError);
  });

  it("surfaces InvalidTransitionError when the array-adjacent next column isn't a legal transition", async () => {
    // blocked's next column per BOARD_COLUMN_ORDER is "done", but the
    // transition graph only allows blocked -> in_progress/ready -- advancing
    // a blocked card should fail loudly, not silently pick a different state.
    const cardId = await makeCard("advance: blocked card", "blocked");

    await expect(advanceCardState({ cardId, actorType: "user" })).rejects.toThrow(InvalidTransitionError);
  });

  it("throws CardNotFoundError for an unknown card id", async () => {
    await expect(advanceCardState({ cardId: "00000000-0000-0000-0000-000000000000", actorType: "user" })).rejects.toThrow(
      CardNotFoundError,
    );
  });
});
