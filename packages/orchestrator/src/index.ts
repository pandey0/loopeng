import { loadConnectorRegistry } from "@loopeng/connectors";
import { HookRegistry } from "./hooks.js";
import { HierarchicalStrategy } from "./coordination/hierarchical.js";
import type { CoordinationStrategy } from "./coordination/types.js";
import { startCronTriggers } from "./triggers/cron-trigger.js";
import { startEventTrigger } from "./triggers/event-trigger.js";

export * from "./hooks.js";
export * from "./loop.js";
export * from "./queue.js";
export * from "./router.js";
export * from "./coordination/types.js";
export { HierarchicalStrategy } from "./coordination/hierarchical.js";
export { MeshStrategy } from "./coordination/mesh.js";

export interface Orchestrator {
  coordination: CoordinationStrategy;
  hooks: HookRegistry;
  stop: () => Promise<void>;
}

// Wires the whole Phase 2 loop together: connectors registered on hooks,
// a hierarchical worker pool for dispatch, cron triage, and an event
// trigger that dispatches a card the moment it's manually dragged to
// "ready" — so the autonomous loop and human-driven board interleave
// naturally instead of being two separate systems.
export async function startOrchestrator(): Promise<Orchestrator> {
  const hooks = new HookRegistry();
  const connectors = await loadConnectorRegistry();

  hooks.on("onFailure", async (ctx) => {
    await connectors.notifyAll({
      text: `Card ${ctx.cardId} failed orchestration: ${ctx.reason ?? "unknown"} (attempt ${ctx.attempt ?? "?"})`,
      context: ctx,
    });
  });

  const coordination = new HierarchicalStrategy(hooks);
  coordination.start();

  startCronTriggers(coordination);
  const stopEventTrigger = startEventTrigger(coordination);

  return {
    coordination,
    hooks,
    stop: async () => {
      stopEventTrigger();
      await coordination.stop();
    },
  };
}
