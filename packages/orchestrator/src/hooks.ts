export interface OrchestrationContext {
  cardId: string;
  [key: string]: unknown;
}

export type Hook = (ctx: OrchestrationContext) => Promise<void>;

export type HookName =
  | "beforeCardPickup"
  | "afterWorktreeCreated"
  | "beforeSubAgentVerify"
  | "afterGateRun"
  | "beforeDeploy"
  | "onFailure";

// Connectors subscribe here declaratively (e.g. Slack registers on
// "onFailure") instead of being hardcoded into the orchestrator loop.
export class HookRegistry {
  private readonly hooks = new Map<HookName, Hook[]>();

  on(name: HookName, hook: Hook): void {
    const list = this.hooks.get(name) ?? [];
    list.push(hook);
    this.hooks.set(name, list);
  }

  async fire(name: HookName, ctx: OrchestrationContext): Promise<void> {
    const list = this.hooks.get(name) ?? [];
    for (const hook of list) {
      try {
        await hook(ctx);
      } catch (err) {
        console.error(`[orchestrator:hooks] hook "${name}" failed`, err);
      }
    }
  }
}
