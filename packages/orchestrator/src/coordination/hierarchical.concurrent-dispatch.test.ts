import { eq } from "drizzle-orm";
import { boards, cards, db, pool, projects } from "@loopeng/db";
import { applyTransition } from "@loopeng/board-engine";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../hooks.js";

// The 2026-07-02 incident, reproduced at the layer it actually happened at:
// "two independent single-worker queues each honored concurrency=1
// internally but raced against each other" -- two DIFFERENT ready cards
// (9b1775e7 and 1211d818) landed in in_progress at the same time because two
// separate HierarchicalStrategy instances (one per orchestrator process)
// were each dispatching against the same DATABASE_URL. state-machine.test.ts
// already covers the narrower TOCTOU (two callers racing the *same* card);
// this file covers the actual incident shape, which is about the number of
// independent dispatchers, not a single card's transition guard.
const tracker = vi.hoisted(() => ({
  intervals: [] as { cardId: string; start: number; end: number }[],
  holdMs: 60,
}));

vi.mock("../loop.js", () => ({
  orchestrateCard: async (cardId: string) => {
    const start = Date.now();
    await applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
    await new Promise((resolve) => setTimeout(resolve, tracker.holdMs));
    tracker.intervals.push({ cardId, start, end: Date.now() });
  },
}));

const { HierarchicalStrategy } = await import("./hierarchical.js");

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

// dispatch() only enqueues -- it resolves as soon as the job is pushed onto
// the (possibly in-process, fire-and-forget) queue, not once the handler has
// actually run. Poll for the handler(s) to finish recording their interval
// before asserting on it.
async function waitForIntervals(countBefore: number, expectedNew: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (tracker.intervals.length < countBefore + expectedNew) {
    if (Date.now() > deadline) throw new Error("timed out waiting for orchestrateCard to finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("HierarchicalStrategy (concurrent dispatch across processes)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };
  const strategies: InstanceType<typeof HierarchicalStrategy>[] = [];

  afterAll(async () => {
    for (const s of strategies) await s.stop();
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    await pool.end();
  });

  async function makeReadyCard(title: string) {
    const [project] = await db.insert(projects).values({ name: `${title} project`, repoPath: "/tmp/does-not-matter" }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `${title} board`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state: "ready" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  it("a single orchestrator instance (ORCHESTRATOR_CONCURRENCY default = 1) never has two ready cards in in_progress at once", async () => {
    const cardA = await makeReadyCard("single-instance: card A");
    const cardB = await makeReadyCard("single-instance: card B");

    const strategy = new HierarchicalStrategy(new HookRegistry());
    strategies.push(strategy);
    strategy.start();

    const before = tracker.intervals.length;
    await Promise.all([strategy.dispatch(cardA), strategy.dispatch(cardB)]);
    await waitForIntervals(before, 2);
    const [ivA, ivB] = tracker.intervals.slice(before);
    if (!ivA || !ivB) throw new Error("expected two recorded intervals");

    // The whole point of a single concurrency=1 queue: the second job's
    // handler cannot start until the first one's has fully returned, so the
    // two intervals must not overlap at all -- one strictly finishes before
    // the other starts.
    expect(overlaps(ivA, ivB)).toBe(false);

    const [cardAAfter] = await db.select().from(cards).where(eq(cards.id, cardA));
    const [cardBAfter] = await db.select().from(cards).where(eq(cards.id, cardB));
    expect(cardAAfter?.state).toBe("in_progress");
    expect(cardBAfter?.state).toBe("in_progress");
  });

  it("two independent orchestrator instances DO race two ready cards into in_progress simultaneously -- this is exactly the bug a second, worktree-local instance must never be allowed to start (see apps/api orchestrator.test.ts's ORCHESTRATOR_ENABLED gate)", async () => {
    const cardC = await makeReadyCard("two-instance race: card C");
    const cardD = await makeReadyCard("two-instance race: card D");

    const strategyOne = new HierarchicalStrategy(new HookRegistry());
    const strategyTwo = new HierarchicalStrategy(new HookRegistry());
    strategies.push(strategyOne, strategyTwo);
    strategyOne.start();
    strategyTwo.start();

    const before = tracker.intervals.length;
    await Promise.all([strategyOne.dispatch(cardC), strategyTwo.dispatch(cardD)]);
    await waitForIntervals(before, 2);
    const [ivC, ivD] = tracker.intervals.slice(before);
    if (!ivC || !ivD) throw new Error("expected two recorded intervals");

    // Two separate single-worker queues each honor their own concurrency=1
    // but have no idea the other exists -- their windows overlap, both cards
    // land in in_progress at the same time. This is the 2026-07-02 incident
    // itself; the fix is that a worktree-local api process can never reach
    // this code path at all (ORCHESTRATOR_ENABLED gate in
    // apps/api/src/plugins/orchestrator.ts), not a change to this class.
    expect(overlaps(ivC, ivD)).toBe(true);

    const [cardCAfter] = await db.select().from(cards).where(eq(cards.id, cardC));
    const [cardDAfter] = await db.select().from(cards).where(eq(cards.id, cardD));
    expect(cardCAfter?.state).toBe("in_progress");
    expect(cardDAfter?.state).toBe("in_progress");
  });
});
