import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, eventLog } from "@loopeng/db";
import { canTransition } from "@loopeng/shared";
import type { CardState } from "@loopeng/shared";

// Transition graph lives in @loopeng/shared so client code (the board UI)
// can validate drags without pulling in this package's @loopeng/db dependency.
export { TRANSITIONS, canTransition } from "@loopeng/shared";

export interface ApplyTransitionInput {
  cardId: string;
  toState: CardState;
  actorType: "user" | "agent" | "automation";
  actorId?: string;
  /** Why -- recorded on the event itself since it's the only durable record once the card moves on. */
  reason?: string;
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
    payload: input.reason ? { from: fromState, to: input.toState, reason: input.reason } : { from: fromState, to: input.toState },
  });

  return updated;
}
