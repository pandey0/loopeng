import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { boards, cards, db, pool, worktrees } from "@loopeng/db";
import { afterAll, describe, expect, it } from "vitest";
import { syncWorktreeOntoBase } from "./sync.js";

// Real (non-mocked) end-to-end test for the deploy-time rebase-and-resolve
// step (see docker-compose.ts's deploy()). Builds a throwaway git repo (never
// the real loopeng repo — deliberately isolated so a bad resolution can't
// touch anything real) with a linked worktree, engineers the exact conflict
// shape seen all session (two independent commits appending a different
// entry to the same array), then drives a real Claude CLI integrator agent
// to resolve it via syncWorktreeOntoBase. Proves the union-not-drop behavior
// actually happens, not just that the prompt asks for it.
describe("syncWorktreeOntoBase (real end-to-end)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("resolves a real rebase conflict via the integrator agent and keeps both sides' additive changes", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "sync-e2e-base-"));
    const worktreePath = await mkdtemp(path.join(tmpdir(), "sync-e2e-worktree-"));
    await rm(worktreePath, { recursive: true, force: true }); // git worktree add requires the target not exist

    const baseGit = simpleGit(repoRoot);
    await baseGit.init(["-b", "main"]);
    await baseGit.addConfig("user.email", "sync-e2e@test.local");
    await baseGit.addConfig("user.name", "sync-e2e");

    // A minimal but real "pnpm test" target -- the integrator's prompt tells
    // it to run this before continuing, and sync.ts re-runs it as the
    // post-resolution safety net, so it has to actually exist and pass.
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "sync-e2e-fixture", scripts: { test: "true" } }, null, 2));
    await writeFile(
      path.join(repoRoot, "roles.txt"),
      ["roles:", "- implementer", "- reviewer", ""].join("\n"),
    );
    await baseGit.add(["."]);
    await baseGit.commit("base: seed roles list");

    // Card's own branch, created off this base commit -- mirrors createWorktree.
    await baseGit.raw(["worktree", "add", worktreePath, "-b", "card-branch", "main"]);
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.addConfig("user.email", "sync-e2e@test.local");
    await worktreeGit.addConfig("user.name", "sync-e2e");
    await writeFile(path.join(worktreePath, "roles.txt"), ["roles:", "- implementer", "- reviewer", "- designer", ""].join("\n"));
    await worktreeGit.add(["roles.txt"]);
    await worktreeGit.commit("feat: add designer role");

    // Meanwhile, on base -- another card landed a *different* additive entry
    // to the exact same line. Same shape as every real conflict this session.
    await writeFile(path.join(repoRoot, "roles.txt"), ["roles:", "- implementer", "- reviewer", "- tech-manager", ""].join("\n"));
    await baseGit.add(["roles.txt"]);
    await baseGit.commit("feat: add tech-manager role");

    const [board] = await db.insert(boards).values({ name: "sync-e2e throwaway board" }).returning();
    const [card] = await db
      .insert(cards)
      .values({ boardId: board!.id, title: "sync-e2e: add designer role", description: "Throwaway fixture card for syncWorktreeOntoBase e2e test." })
      .returning();
    const [worktreeRow] = await db
      .insert(worktrees)
      .values({
        cardId: card!.id,
        repoUrl: repoRoot,
        branchName: "card-branch",
        fsPath: worktreePath,
        baseCommitSha: (await baseGit.revparse(["main~1"])).trim(),
        status: "active",
      })
      .returning();

    try {
      const result = await syncWorktreeOntoBase({
        card: card!,
        worktree: worktreeRow!,
        repoRoot,
        baseBranch: "main",
      });

      expect(result.ok, JSON.stringify(result.detail)).toBe(true);
      expect(result.detail.conflicts).toBe(true);
      expect(result.detail.resolvedBy).toBe("integrator");

      const rebaseMergePath = (await worktreeGit.raw(["rev-parse", "--git-path", "rebase-merge"])).trim();
      expect(existsSync(path.resolve(worktreePath, rebaseMergePath))).toBe(false);

      const finalContent = await readFile(path.join(worktreePath, "roles.txt"), "utf-8");
      expect(finalContent).toContain("tech-manager");
      expect(finalContent).toContain("designer");

      const worktreeStatus = await worktreeGit.status();
      expect(worktreeStatus.isClean()).toBe(true);
    } finally {
      // cards.id cascades to both agent_runs (the integrator's run row) and
      // worktrees, so deleting the card alone is enough to clean up all three.
      await db.delete(cards).where(eq(cards.id, card!.id));
      await db.delete(boards).where(eq(boards.id, board!.id));
      await baseGit.raw(["worktree", "remove", "--force", worktreePath]).catch(() => {});
      await rm(repoRoot, { recursive: true, force: true });
      await rm(worktreePath, { recursive: true, force: true });
    }
  }, 300_000);
});
