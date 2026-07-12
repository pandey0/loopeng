import { eq } from "drizzle-orm";
import { boards, cardDependencies, cards, db, pool, projects } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { afterAll, describe, expect, it } from "vitest";
import type { CoordinationStrategy } from "../coordination/types.js";
import { promoteUnblockedDependents, sweepReadyCardsAtBoot } from "./event-trigger.js";

function fakeCoordination() {
  const dispatched: string[] = [];
  const coordination: CoordinationStrategy = {
    dispatch: async (cardId: string) => {
      dispatched.push(cardId);
    },
    start: () => {},
    stop: async () => {},
  };
  return { coordination, dispatched };
}

describe("promoteUnblockedDependents", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
  });

  async function makeBoard(title: string) {
    const [project] = await db.insert(projects).values({ name: `${title} project`, repoPath: "/tmp/does-not-matter" }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `${title} board`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);
    return board.id;
  }

  async function makeCard(boardId: string, title: string, state: string) {
    const [card] = await db.insert(cards).values({ boardId, title, state }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  it("promotes a backlog dependent to ready once its last blocker is done", async () => {
    const boardId = await makeBoard("backlog dependent");
    const blockerId = await makeCard(boardId, "blocker", "in_review");
    const dependentId = await makeCard(boardId, "dependent", "backlog");
    await db.insert(cardDependencies).values({ cardId: dependentId, dependsOnCardId: blockerId, dependencyType: "blocks" });

    await applyTransition({ cardId: blockerId, toState: "done", actorType: "automation" });

    const { coordination, dispatched } = fakeCoordination();
    await promoteUnblockedDependents(blockerId, coordination);

    const [dependent] = await db.select().from(cards).where(eq(cards.id, dependentId));
    expect(dependent?.state).toBe("ready");
    expect(dispatched).toHaveLength(0);
  });

  // Regression: a card can be manually dragged to ready before its
  // dependency actually finishes -- its own ready-transition event finds
  // isReady() false and skips dispatch, and nothing was ever re-checking it
  // afterward. This is the fix: a ready dependent gets dispatched directly
  // (no transition needed, it's already in the right column) instead of
  // being silently ignored because it isn't sitting in backlog.
  it("dispatches a dependent that's already in ready once its last blocker is done", async () => {
    const boardId = await makeBoard("ready dependent");
    const blockerId = await makeCard(boardId, "blocker", "in_review");
    const dependentId = await makeCard(boardId, "dependent", "ready");
    await db.insert(cardDependencies).values({ cardId: dependentId, dependsOnCardId: blockerId, dependencyType: "blocks" });

    await applyTransition({ cardId: blockerId, toState: "done", actorType: "automation" });

    const { coordination, dispatched } = fakeCoordination();
    await promoteUnblockedDependents(blockerId, coordination);

    expect(dispatched).toEqual([dependentId]);

    const [dependent] = await db.select().from(cards).where(eq(cards.id, dependentId));
    expect(dependent?.state).toBe("ready");
  });

  it("does nothing for a dependent that still has another unmet blocker", async () => {
    const boardId = await makeBoard("still blocked");
    const blockerAId = await makeCard(boardId, "blocker A", "in_review");
    const blockerBId = await makeCard(boardId, "blocker B", "backlog");
    const dependentId = await makeCard(boardId, "dependent", "ready");
    await db.insert(cardDependencies).values([
      { cardId: dependentId, dependsOnCardId: blockerAId, dependencyType: "blocks" },
      { cardId: dependentId, dependsOnCardId: blockerBId, dependencyType: "blocks" },
    ]);

    await applyTransition({ cardId: blockerAId, toState: "done", actorType: "automation" });

    const { coordination, dispatched } = fakeCoordination();
    await promoteUnblockedDependents(blockerAId, coordination);

    expect(dispatched).toHaveLength(0);
  });

  it("ignores a dependent that's already past ready (in_progress or later)", async () => {
    const boardId = await makeBoard("already running");
    const blockerId = await makeCard(boardId, "blocker", "in_review");
    const dependentId = await makeCard(boardId, "dependent", "in_progress");
    await db.insert(cardDependencies).values({ cardId: dependentId, dependsOnCardId: blockerId, dependencyType: "blocks" });

    await applyTransition({ cardId: blockerId, toState: "done", actorType: "automation" });

    const { coordination, dispatched } = fakeCoordination();
    await promoteUnblockedDependents(blockerId, coordination);

    expect(dispatched).toHaveLength(0);
    const [dependent] = await db.select().from(cards).where(eq(cards.id, dependentId));
    expect(dependent?.state).toBe("in_progress");
  });
});

// Regression: a card whose card.moved-to-ready event predates the
// orchestrator's boot-time cursor (set to the current max event_log id) was
// silently invisible to the event-trigger's poll loop forever, since it only
// dispatches events with id > that cursor. sweepReadyCardsAtBoot re-checks
// current board state instead of past events, so a restart can never strand
// a ready card indefinitely.
describe("sweepReadyCardsAtBoot", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
  });

  async function makeBoard(title: string) {
    const [project] = await db.insert(projects).values({ name: `${title} project`, repoPath: "/tmp/does-not-matter" }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `${title} board`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);
    return board.id;
  }

  async function makeCard(boardId: string, title: string, state: string) {
    const [card] = await db.insert(cards).values({ boardId, title, state }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  it("dispatches a card that's sitting in ready with no unmet dependencies, as if it were a fresh event", async () => {
    const boardId = await makeBoard("boot sweep ready");
    const cardId = await makeCard(boardId, "orphaned ready card", "ready");

    const { coordination, dispatched } = fakeCoordination();
    await sweepReadyCardsAtBoot(coordination);

    expect(dispatched).toContain(cardId);
  });

  it("skips a ready card that still has an unmet blocking dependency", async () => {
    const boardId = await makeBoard("boot sweep blocked");
    const blockerId = await makeCard(boardId, "blocker", "backlog");
    const cardId = await makeCard(boardId, "blocked ready card", "ready");
    await db.insert(cardDependencies).values({ cardId, dependsOnCardId: blockerId, dependencyType: "blocks" });

    const { coordination, dispatched } = fakeCoordination();
    await sweepReadyCardsAtBoot(coordination);

    expect(dispatched).not.toContain(cardId);
  });

  it("does not dispatch cards outside the ready state", async () => {
    const boardId = await makeBoard("boot sweep backlog");
    const cardId = await makeCard(boardId, "not ready yet", "backlog");

    const { coordination, dispatched } = fakeCoordination();
    await sweepReadyCardsAtBoot(coordination);

    expect(dispatched).not.toContain(cardId);
  });
});

afterAll(async () => {
  await pool.end();
});
