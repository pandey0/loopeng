import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startOrchestrator = vi.fn();
const reconcileOrphanedRuns = vi.fn().mockResolvedValue(0);
const reconcileRateLimitedCards = vi.fn().mockResolvedValue(0);

vi.mock("@loopeng/orchestrator", () => ({
  startOrchestrator: (...args: unknown[]) => startOrchestrator(...args),
  reconcileOrphanedRuns: (...args: unknown[]) => reconcileOrphanedRuns(...args),
  reconcileRateLimitedCards: (...args: unknown[]) => reconcileRateLimitedCards(...args),
}));

// Regression test for the 2026-07-02 incident: a worktree-local copy of
// apps/api (e.g. spun up by an implementer agent via `tsx watch` to eyeball
// a UI change) must never auto-start a second orchestrator against the same
// DATABASE_URL as the real instance -- that's what let two independent
// single-worker queues race each other into dispatching the same ready card
// into in_progress twice. Enabling dispatch must be an explicit opt-in.
//
// Also covers the 2026-07-12 incident: the two reconcile sweeps used to run
// unconditionally, ahead of the ORCHESTRATOR_ENABLED check, on the theory
// that they're harmless data hygiene. They aren't -- reconcileOrphanedRuns
// can't distinguish a run whose owning process really crashed from one
// that's alive right now under a *different* process, so a worktree's own
// dev-server boot would see its own currently-running agent as "orphaned"
// and yank the card out from under it mid-run. Both sweeps must be gated
// behind the same opt-in boundary as dispatch.
describe("orchestratorPlugin", () => {
  const originalEnv = process.env.ORCHESTRATOR_ENABLED;

  beforeEach(() => {
    startOrchestrator.mockReset();
    reconcileOrphanedRuns.mockReset();
    reconcileOrphanedRuns.mockResolvedValue(0);
    reconcileRateLimitedCards.mockReset();
    reconcileRateLimitedCards.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ORCHESTRATOR_ENABLED;
    else process.env.ORCHESTRATOR_ENABLED = originalEnv;
  });

  async function buildApp() {
    const { orchestratorPlugin } = await import("./orchestrator.js");
    const fastify = Fastify();
    await fastify.register(orchestratorPlugin);
    return fastify;
  }

  it("never calls startOrchestrator or either reconcile sweep when ORCHESTRATOR_ENABLED is unset (the default for a worktree-local process)", async () => {
    delete process.env.ORCHESTRATOR_ENABLED;
    const fastify = await buildApp();
    try {
      expect(startOrchestrator).not.toHaveBeenCalled();
      expect((fastify as unknown as { orchestrator?: unknown }).orchestrator).toBeUndefined();
      // A worktree-local boot must never touch the shared DB's agent_runs/
      // cards rows -- it has no way to know a "stuck" run isn't actually
      // alive under the real instance right now.
      expect(reconcileOrphanedRuns).not.toHaveBeenCalled();
      expect(reconcileRateLimitedCards).not.toHaveBeenCalled();
    } finally {
      await fastify.close();
    }
  });

  it("never calls startOrchestrator for any value other than the literal \"1\" (e.g. a stray/truthy-looking string)", async () => {
    process.env.ORCHESTRATOR_ENABLED = "true";
    const fastify = await buildApp();
    try {
      expect(startOrchestrator).not.toHaveBeenCalled();
    } finally {
      await fastify.close();
    }
  });

  it("starts the orchestrator and runs both reconcile sweeps only when ORCHESTRATOR_ENABLED=1 is explicitly set (the real instance)", async () => {
    process.env.ORCHESTRATOR_ENABLED = "1";
    const stop = vi.fn().mockResolvedValue(undefined);
    startOrchestrator.mockResolvedValue({ coordination: {}, hooks: {}, stop });

    const fastify = await buildApp();
    try {
      expect(startOrchestrator).toHaveBeenCalledTimes(1);
      expect(reconcileOrphanedRuns).toHaveBeenCalledTimes(1);
      expect(reconcileRateLimitedCards).toHaveBeenCalledTimes(1);
      expect((fastify as unknown as { orchestrator?: unknown }).orchestrator).toBeDefined();
    } finally {
      await fastify.close();
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });
});
