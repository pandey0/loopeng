import { and, eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { applyTransition, ConcurrentTransitionError, InvalidTransitionError } from "./state-machine.js";

// Regression test for the 2026-07-02 duplicate-orchestrator incident: two
// dispatchers racing to move the same ready card into in_progress at the
// same time. Reproduces the race directly against the real DB rather than
// standing up two orchestrator processes -- applyTransition's SELECT-then-
// UPDATE was a TOCTOU (both callers read state="ready", both passed
// canTransition, both UPDATEd) before the WHERE state=fromState guard was
// added; this proves that guard actually closes it under real concurrent
// requests, not just in a single-threaded unit test.
describe("applyTransition (concurrent dispatch)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
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

  it("lets only one of many concurrent ready->in_progress calls on the same card win", async () => {
    const cardId = await makeReadyCard("race: many dispatchers, one ready card");

    // A plain two-call race can collapse to effectively sequential on a fast
    // local DB (the first call's SELECT+UPDATE+INSERT round-trips all land
    // before the second call's SELECT is even dispatched), which would pass
    // even against the old unguarded UPDATE for the wrong reason (the second
    // caller's re-SELECT already sees "in_progress" and canTransition itself
    // rejects it, never reaching the UPDATE this test is about). Firing many
    // concurrent calls widens the window so several SELECTs genuinely land
    // before any UPDATE commits -- exercising the same shape of race that
    // let two orchestrator instances both dispatch a ready card.
    const attempt = () => applyTransition({ cardId, toState: "in_progress", actorType: "agent" });
    const results = await Promise.allSettled(Array.from({ length: 10 }, attempt));

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    // Every loser is rejected by either this call's own guard
    // (ConcurrentTransitionError, if its SELECT raced in ahead of the
    // winner's UPDATE) or by re-reading the now-updated state
    // (InvalidTransitionError, if its SELECT landed after) -- either way it
    // never re-applies the transition.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason instanceof ConcurrentTransitionError || reason instanceof InvalidTransitionError).toBe(true);
    }

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("in_progress");

    // Exactly one card.moved event was recorded for this transition -- no
    // loser got far enough to write a second one.
    const movedEvents = await db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.entityType, "card"), eq(eventLog.entityId, cardId), eq(eventLog.eventType, "card.moved")));
    expect(movedEvents).toHaveLength(1);
  });

  it("does not affect two unrelated cards dispatching concurrently -- both legitimately reach in_progress", async () => {
    const [cardIdA, cardIdB] = await Promise.all([
      makeReadyCard("race: card A"),
      makeReadyCard("race: card B"),
    ]);

    const [a, b] = await Promise.all([
      applyTransition({ cardId: cardIdA, toState: "in_progress", actorType: "agent" }),
      applyTransition({ cardId: cardIdB, toState: "in_progress", actorType: "agent" }),
    ]);

    expect(a.state).toBe("in_progress");
    expect(b.state).toBe("in_progress");
  });
});
