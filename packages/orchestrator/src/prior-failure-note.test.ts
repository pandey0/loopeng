import { eq } from "drizzle-orm";
import { boards, cards, db, eventLog, gateDefinitions, gateResults, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { formatGateFailureTextFromDb, loadPriorFailureNote } from "./loop.js";

// Regression coverage for the 2026-07-13 incident: priorFailureNote used to
// live only as a loop-local variable inside a single orchestrateCard call,
// reset to undefined every time -- so a card that exhausted MAX_ATTEMPTS and
// was later requeued externally (a human clicking Retry, an auto-retry path)
// dispatched the implementer completely blind to why the previous attempt
// failed. loadPriorFailureNote reconstructs that context by reading the
// last real failure back out of event_log.
describe("loadPriorFailureNote", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    await pool.end();
  });

  async function makeCard(title: string): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({ name: `prior-failure-note test project ${title}`, repoPath: "/tmp/prior-failure-note-test-not-a-real-repo" })
      .returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db
      .insert(boards)
      .values({ name: `prior-failure-note test board ${title}`, projectId: project.id })
      .returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db.insert(cards).values({ boardId: board.id, title, state: "ready" }).returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);
    return card.id;
  }

  async function recordMove(cardId: string, to: string, reason?: string) {
    await db.insert(eventLog).values({
      entityType: "card",
      entityId: cardId,
      eventType: "card.moved",
      actorType: "automation",
      payload: reason ? { to, reason } : { to },
    });
  }

  it("returns undefined for a card with no prior blocked event", async () => {
    const cardId = await makeCard("brand new card");
    await recordMove(cardId, "ready");
    expect(await loadPriorFailureNote(cardId)).toBeUndefined();
  });

  it("reconstructs an implementer-failure note from the persisted reason", async () => {
    const cardId = await makeCard("implementer exhausted attempts");
    await recordMove(cardId, "blocked", "implementer failed after 3 attempts: TypeError: cannot read property 'foo' of undefined");
    await recordMove(cardId, "ready", "requeued for retry");

    const note = await loadPriorFailureNote(cardId);
    expect(note).toContain("Implementer run failed.");
    expect(note).toContain("TypeError");
  });

  it("reconstructs a review-rejection note from the persisted reason", async () => {
    const cardId = await makeCard("review exhausted attempts");
    await recordMove(cardId, "blocked", "review rejected after 3 attempts: CRITERION: handles null email -> NOT SATISFIED");
    await recordMove(cardId, "ready", "requeued for retry");

    const note = await loadPriorFailureNote(cardId);
    expect(note).toContain("Reviewer rejected the previous attempt.");
    expect(note).toContain("NOT SATISFIED");
  });

  it("reconstructs a gate-failure note from the real gate_results detail, not just the truncated event reason", async () => {
    const cardId = await makeCard("gates exhausted attempts");

    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "tests_ci"));
    if (!gateDef) throw new Error("tests_ci gate_definition not seeded");
    await db.insert(gateResults).values({
      cardId,
      gateDefinitionId: gateDef.id,
      status: "failed",
      detail: { stderrTail: "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string" },
    });

    await recordMove(cardId, "blocked", "gate(s) failed after 3 attempts: Tests + CI");
    await recordMove(cardId, "ready", "requeued for retry");

    const note = await loadPriorFailureNote(cardId);
    expect(note).toContain("Automated gate checks failed on the previous attempt.");
    expect(note).toContain("SASL");

    const gateText = await formatGateFailureTextFromDb(cardId);
    expect(gateText).toContain("GATE FAILED: Tests + CI");
    expect(gateText).toContain("SCRAM-SERVER-FIRST-MESSAGE");
  });

  it("ignores a card blocked while waiting on a human answer -- no useful implementer feedback to carry forward", async () => {
    const cardId = await makeCard("waiting on a question");
    await recordMove(cardId, "blocked", "waiting on answer: should this support markdown?");
    await recordMove(cardId, "ready", "question answered");

    expect(await loadPriorFailureNote(cardId)).toBeUndefined();
  });

  it("ignores a restart-orphan block -- not a real failure, no feedback to give", async () => {
    const cardId = await makeCard("restart orphan");
    await recordMove(cardId, "blocked", 'implementer run interrupted (stuck in "running" at boot -- likely an api restart mid-run)');
    await recordMove(cardId, "ready", "auto-requeued: a restart orphan isn't a real failure, safe to retry automatically (1/3)");

    expect(await loadPriorFailureNote(cardId)).toBeUndefined();
  });
});
