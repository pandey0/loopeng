import type { HookRegistry } from "../hooks.js";
import { orchestrateCard } from "../loop.js";
import { createQueue, type JobQueue } from "../queue.js";
import type { CoordinationStrategy } from "./types.js";

interface CardJob {
  cardId: string;
}

// One lead process assigns cards to a bounded worker pool; one worker = one
// agent run at a time (per worker slot). MeshStrategy (multi-agent-per-card)
// is intentionally not implemented yet — see coordination/mesh.ts.
export class HierarchicalStrategy implements CoordinationStrategy {
  private queueReady: Promise<JobQueue<CardJob>> | null = null;

  constructor(
    private readonly hooks: HookRegistry,
    private readonly concurrency = Number(process.env.ORCHESTRATOR_CONCURRENCY ?? 1),
  ) {}

  async dispatch(cardId: string): Promise<void> {
    if (!this.queueReady) throw new Error("HierarchicalStrategy.start() must be called before dispatch()");
    const queue = await this.queueReady;
    await queue.enqueue({ cardId });
  }

  start(): void {
    if (this.queueReady) return;
    this.queueReady = createQueue<CardJob>("loopeng:card-dispatch").then((queue) => {
      queue.process(async ({ cardId }) => {
        await orchestrateCard(cardId, this.hooks);
      }, this.concurrency);
      return queue;
    });
  }

  async stop(): Promise<void> {
    const queue = await this.queueReady;
    await queue?.close();
  }
}
