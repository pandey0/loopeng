import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { boards, cards, db, gateDefinitions, gateResults, pool, projects } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { HookRegistry } from "./hooks.js";
import { orchestrateCard } from "./loop.js";

// Covers the failure path only: a project's repo is missing/invalid at
// dispatch time. This returns out of orchestrateCard before the
// implementer/reviewer/designer agents are ever invoked, so it's a real
// (non-mocked) DB test with no Claude CLI dependency -- see the ADR
// "multi-project-onboarding" for why this must land the card in "blocked"
// with a specific reason instead of leaving it stuck in "ready".
describe("orchestrateCard (invalid project repo)", () => {
  const cleanup = { cardIds: [] as string[], boardIds: [] as string[], projectIds: [] as string[], dirs: [] as string[] };

  afterAll(async () => {
    for (const id of cleanup.cardIds) await db.delete(cards).where(eq(cards.id, id));
    for (const id of cleanup.boardIds) await db.delete(boards).where(eq(boards.id, id));
    for (const id of cleanup.projectIds) await db.delete(projects).where(eq(projects.id, id));
    for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
    await pool.end();
  });

  it("blocks the card with a specific reason instead of throwing out into the caller (the event-trigger's bare .catch)", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "orchestrator-loop-invalid-repo-"));
    cleanup.dirs.push(notARepo); // exists, but was never `git init`-ed

    const [project] = await db.insert(projects).values({ name: "loop test invalid project", repoPath: notARepo }).returning({ id: projects.id });
    if (!project) throw new Error("project insert returned no row");
    cleanup.projectIds.push(project.id);

    const [board] = await db.insert(boards).values({ name: "loop test invalid board", projectId: project.id }).returning({ id: boards.id });
    if (!board) throw new Error("board insert returned no row");
    cleanup.boardIds.push(board.id);

    const [card] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "card dispatched against a non-git repo", state: "ready" })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    cleanup.cardIds.push(card.id);

    const outcome = await orchestrateCard(card.id, new HookRegistry());

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toMatch(/target repo missing or not a git repository/);
    }

    const [cardAfter] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardAfter?.state).toBe("blocked");
    expect(cardAfter?.worktreeId).toBeNull();

    const [gateDef] = await db.select().from(gateDefinitions).where(eq(gateDefinitions.key, "repo_valid"));
    expect(gateDef).toBeDefined();
    const [gateRow] = await db.select().from(gateResults).where(eq(gateResults.cardId, card.id));
    expect(gateRow?.status).toBe("failed");
  });
});
