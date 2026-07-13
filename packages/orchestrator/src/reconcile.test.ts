import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileRateLimitedCards, startRateLimitReconcileLoop } from "./reconcile.js";
import { RATE_LIMIT_MARKER } from "./loop.js";

// Formats a "resets H:MMam/pm (Zone)" clause the same shape as the real
// Claude CLI message, anchored to UTC so the test doesn't depend on the
// runner's local timezone.
function formatResetClause(target: Date): string {
  let hour = target.getUTCHours();
  const minute = target.getUTCMinutes();
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `resets ${hour}:${String(minute).padStart(2, "0")}${meridiem} (UTC)`;
}

// Regression coverage for the 2026-07-12 incidents: (1) scheduleRateLimitRetryAt
// (loop.ts) arms a bare in-memory setTimeout when a card is blocked for a
// rate limit -- an api restart before that timer fires drops the pending
// requeue silently, the card sits in "blocked" forever with nothing else
// watching it; (2) the retry target is the *real* reset instant parsed out
// of the CLI's own message, not a fixed window -- a card blocked hours
// before its account's actual reset must not be requeued early just because
// a fixed clock elapsed. reconcileRateLimitedCards is the boot-time sweep
// that re-derives that real target and closes the restart gap, mirroring
// reconcileOrphanedRuns for restart-orphaned runs.
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

  it("requeues a card whose real reset instant (parsed from the reason) already passed", async () => {
    // Blocked 30 min ago, reset clause 25 min ago -- 5 min after the block,
    // well before now, so re-deriving from the persisted reason must find
    // this overdue regardless of any fixed window.
    const moveAgeMs = 30 * 60 * 1000;
    const resetClause = formatResetClause(new Date(Date.now() - 25 * 60 * 1000));
    const cardId = await makeBlockedCard(
      "overdue rate-limit block",
      moveAgeMs,
      `${RATE_LIMIT_MARKER} — retrying automatically in ~5 min: You've hit your session limit · ${resetClause}`,
    );

    const requeued = await reconcileRateLimitedCards();
    expect(requeued).toBeGreaterThanOrEqual(1);

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("ready");
  });

  it("leaves a card blocked if its real reset instant hasn't passed yet, even long after a fixed 20-minute window would have elapsed", async () => {
    // Blocked 30 min ago (past the old fixed 20-minute window), but the
    // reset clause names a moment 10 min from now -- the account genuinely
    // isn't usable yet, so requeuing early would just burn the retry.
    const moveAgeMs = 30 * 60 * 1000;
    const resetClause = formatResetClause(new Date(Date.now() + 10 * 60 * 1000));
    const cardId = await makeBlockedCard(
      "still-limited rate-limit block",
      moveAgeMs,
      `${RATE_LIMIT_MARKER} — retrying automatically in ~40 min: You've hit your session limit · ${resetClause}`,
    );

    await reconcileRateLimitedCards();

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("blocked");
  });

  it("ignores a card blocked for a non-rate-limit reason", async () => {
    const cardId = await makeBlockedCard("gate failure block", 30 * 60 * 1000, "gate failed: tests_ci");

    await reconcileRateLimitedCards();

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(cardAfter?.state).toBe("blocked");
  });

  // Regression coverage for the 2026-07-13 incident: seven cards blocked for
  // a rate limit sat 80+ minutes overdue in a process that never restarted --
  // scheduleRateLimitRetryAt's own setTimeout silently never fired, for a
  // reason never fully pinned down. The fix wasn't to debug that one timer
  // harder; it was to stop depending on any single timer firing at all.
  // startRateLimitReconcileLoop is a self-rescheduling poll (same shape as
  // triggers/event-trigger.ts) that calls reconcileRateLimitedCards on a
  // short interval -- this proves the loop itself actually ticks and
  // requeues, independent of whatever scheduleRateLimitRetryAt does.
  it("startRateLimitReconcileLoop requeues an overdue card on its own, without relying on scheduleRateLimitRetryAt", async () => {
    const originalPollMs = process.env.ORCHESTRATOR_RATE_LIMIT_POLL_MS;
    process.env.ORCHESTRATOR_RATE_LIMIT_POLL_MS = "30";

    const resetClause = formatResetClause(new Date(Date.now() - 5 * 60 * 1000));
    const cardId = await makeBlockedCard(
      "loop-requeued overdue block",
      10 * 60 * 1000,
      `${RATE_LIMIT_MARKER} — retrying automatically in ~5 min: You've hit your session limit · ${resetClause}`,
    );

    const stop = startRateLimitReconcileLoop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const [cardAfter] = await db.select().from(cards).where(eq(cards.id, cardId));
      expect(cardAfter?.state).toBe("ready");
    } finally {
      stop();
      if (originalPollMs === undefined) delete process.env.ORCHESTRATOR_RATE_LIMIT_POLL_MS;
      else process.env.ORCHESTRATOR_RATE_LIMIT_POLL_MS = originalPollMs;
    }
  });
});
