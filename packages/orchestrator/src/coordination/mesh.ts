import type { CoordinationStrategy } from "./types.js";

// Multi-agent-per-card collaboration. Deliberately not implemented — there is
// no concrete use case for it yet, and building it ahead of one would be
// speculative. The interface exists so HierarchicalStrategy isn't the only
// shape the router can ever dispatch through.
export class MeshStrategy implements CoordinationStrategy {
  async dispatch(): Promise<void> {
    throw new Error("MeshStrategy is not implemented yet — see packages/orchestrator/src/coordination/mesh.ts");
  }
  start(): void {
    throw new Error("MeshStrategy is not implemented yet — see packages/orchestrator/src/coordination/mesh.ts");
  }
  async stop(): Promise<void> {}
}
