import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileRateLimitedCards } from "./reconcile.js";
import { RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_MARKER } from "./loop.js";

// Regression coverage for the 2026-07-12 incident: scheduleRateLimitRetry
// (loop.ts) arms a bare in-memory setTimeout when a card is blocked for a
// rate limit. An api restart before that timer fires drops the pending
// requeue silently -- the card sits in "blocked" forever with nothing else
// watching it. reconcileRateLimitedCards is the boot-time sweep that closes
// that gap, mirroring reconcileOrphanedRuns for restart-orphaned runs.
describe("reconcileRateLimitedCards", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    await pool.end();
  });

  async function makeBlockedCard(title: string, moveAgeMs: number, reason: string) {
    const [project] = await db
      .insert(projects)
      .values({ name: `reconcile test project ${title}`, repoPath: "/tmp/reconcile-test-not-a-real-repo" })
      .returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: `reconcile test board ${title}`, projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state: "blocked" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);

    await db.insert(eventLog).values({
      entityType: "card",
      entityId: card.id,
      eventType: "card.moved",
      actorType: "automation",
      payload: { to: "blocked", from: "in_progress", reason },
      createdAt: new Date(Date.now() - moveAgeMs),
    });

    return card.id;
  }

  it("requeues a card whose rate-limit backoff window already elapsed", async () => {
    const cardId = await makeBlockedCard(
      "overdue rate-limit block",
      RATE_LIMIT_BACKOFF_MS + 60_000,
      `${RATE_LIMIT_MARKER} — retrying automatically in ~20 min: session limit hit`,
    );

    const requeued = await reconcileRateLimitedCards();
    expect(requeued).toBeGreaterThanOrEqual(1);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("ready");
  });

  it("leaves a card blocked if its rate-limit backoff window hasn't elapsed yet", async () => {
    const cardId = await makeBlockedCard(
      "fresh rate-limit block",
      30_000,
      `${RATE_LIMIT_MARKER} — retrying automatically in ~20 min: session limit hit`,
    );

    await reconcileRateLimitedCards();

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("blocked");
  });

  it("ignores a card blocked for a non-rate-limit reason", async () => {
    const cardId = await makeBlockedCard("gate failure block", RATE_LIMIT_BACKOFF_MS + 60_000, "gate failed: tests_ci");

    await reconcileRateLimitedCards();

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("blocked");
  });
});
