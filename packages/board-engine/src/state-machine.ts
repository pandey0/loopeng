import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, eventLog } from "@loopeng/db";
import type { CardState } from "@loopeng/shared";

// Full state graph reserved from day one so Phase 3/4 gate-driven states
// (gate_checks, awaiting_approval, deploying) don't require a data migration
// reshuffling card history once they go live. Phase 1 only exercises the
// backlog/ready/in_progress/in_review/done/blocked/cancelled subset, plus a
// direct in_review -> done edge for humans moving cards manually before any
// gate pipeline exists (Phase 3 will route through gate_checks instead).
export const TRANSITIONS: Record<CardState, CardState[]> = {
  backlog: ["ready", "cancelled"],
  ready: ["in_progress", "cancelled"],
  in_progress: ["in_review", "blocked"],
  in_review: ["gate_checks", "done", "blocked"],
  gate_checks: ["awaiting_approval", "deploying", "blocked"],
  awaiting_approval: ["deploying", "blocked"],
  deploying: ["done", "blocked"],
  blocked: ["in_progress", "ready"],
  done: [],
  cancelled: [],
};

export function canTransition(from: CardState, to: CardState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ApplyTransitionInput {
  cardId: string;
  toState: CardState;
  actorType: "user" | "agent" | "automation";
  actorId?: string;
}

export class InvalidTransitionError extends Error {
  constructor(from: CardState, to: CardState) {
    super(`cannot transition card from "${from}" to "${to}"`);
  }
}

export async function applyTransition(input: ApplyTransitionInput) {
  const [card] = await db.select().from(cards).where(eq(cards.id, input.cardId));
  if (!card) throw new Error(`card not found: ${input.cardId}`);

  const fromState = card.state as CardState;
  if (!canTransition(fromState, input.toState)) {
    throw new InvalidTransitionError(fromState, input.toState);
  }

  const [updated] = await db
    .update(cards)
    .set({ state: input.toState, updatedAt: new Date() })
    .where(eq(cards.id, input.cardId))
    .returning();

  await db.insert(eventLog).values({
    entityType: "card",
    entityId: input.cardId,
    eventType: "card.moved",
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    payload: { from: fromState, to: input.toState },
  });

  return updated;
}
