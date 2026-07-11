import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startOrchestrator = vi.fn();

vi.mock("@loopeng/orchestrator", () => ({
  startOrchestrator: (...args: unknown[]) => startOrchestrator(...args),
}));

// Regression test for the 2026-07-02 incident: a worktree-local copy of
// apps/api (e.g. spun up by an implementer agent via `tsx watch` to eyeball
// a UI change) must never auto-start a second orchestrator against the same
// DATABASE_URL as the real instance -- that's what let two independent
// single-worker queues race each other into dispatching the same ready card
// into in_progress twice. Enabling dispatch must be an explicit opt-in.
describe("orchestratorPlugin", () => {
  const originalEnv = process.env.ORCHESTRATOR_ENABLED;

  beforeEach(() => {
    startOrchestrator.mockReset();
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

  it("never calls startOrchestrator when ORCHESTRATOR_ENABLED is unset (the default for a worktree-local process)", async () => {
    delete process.env.ORCHESTRATOR_ENABLED;
    const fastify = await buildApp();
    try {
      expect(startOrchestrator).not.toHaveBeenCalled();
      expect((fastify as unknown as { orchestrator?: unknown }).orchestrator).toBeUndefined();
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

  it("starts the orchestrator only when ORCHESTRATOR_ENABLED=1 is explicitly set (the real instance)", async () => {
    process.env.ORCHESTRATOR_ENABLED = "1";
    const stop = vi.fn().mockResolvedValue(undefined);
    startOrchestrator.mockResolvedValue({ coordination: {}, hooks: {}, stop });

    const fastify = await buildApp();
    try {
      expect(startOrchestrator).toHaveBeenCalledTimes(1);
      expect((fastify as unknown as { orchestrator?: unknown }).orchestrator).toBeDefined();
    } finally {
      await fastify.close();
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });
});
