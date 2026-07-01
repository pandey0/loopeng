import type { cards } from "@loopeng/db";
import type { ConnectorRegistry } from "@loopeng/connectors";

export type CardRow = typeof cards.$inferSelect;

export interface GateContext {
  card: CardRow;
  worktreePath: string;
  connectors: ConnectorRegistry;
  config: Record<string, unknown>;
}

export interface GateOutcome {
  status: "passed" | "failed" | "skipped";
  detail: Record<string, unknown>;
}

export interface GateCheck {
  key: string;
  name: string;
  appliesTo(ctx: GateContext): Promise<boolean> | boolean;
  run(ctx: GateContext): Promise<GateOutcome>;
}
