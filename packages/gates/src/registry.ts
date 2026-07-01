import type { GateCheck } from "./types.js";

const registry = new Map<string, GateCheck>();

// New gate = new file in checks/ calling registerGate() at import time — no
// orchestrator changes needed. Enabling/disabling per board is a
// gate_definitions.enabled toggle in the DB, not a code change either.
export function registerGate(gate: GateCheck): void {
  registry.set(gate.key, gate);
}

export function allGates(): GateCheck[] {
  return [...registry.values()];
}

export function getGate(key: string): GateCheck | undefined {
  return registry.get(key);
}
