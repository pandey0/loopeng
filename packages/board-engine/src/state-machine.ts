import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cards, eventLog } from "@loopeng/db";
import { canTransition, getNextState } from "@loopeng/shared";
import type { CardState } from "@loopeng/shared";

// Transition graph lives in @loopeng/shared so client code (the board UI)
// can validate drags without pulling in this package's @loopeng/db dependency.
export { TRANSITIONS, canTransition, NEXT_STATE, getNextState } from "@loopeng/shared";

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

// Thrown when the UPDATE below's WHERE state=fromState guard matches zero
// rows -- i.e. some other transition (another dispatcher, a concurrent
// request) already moved this card off the state this call read, between
// this call's SELECT and its UPDATE. Distinct from InvalidTransitionError
// (a transition that was never legal) -- this one was legal *at read time*
// but lost a race to become the one that actually applies.
export class ConcurrentTransitionError extends Error {
  constructor(cardId: string, from: CardState, to: CardState) {
    super(`card ${cardId} was no longer in state "${from}" when transitioning to "${to}" -- concurrent transition`);
  }
}

// The read (SELECT state) and the write (UPDATE state) are two separate
// statements, so without a guard on the UPDATE this is a classic TOCTOU: two
// callers can both SELECT the same fromState, both pass canTransition, and
// both UPDATE -- e.g. two orchestrator instances racing to dispatch the same
// ready card into in_progress simultaneously (see the 2026-07-02 duplicate
// orchestrator incident). Guarding the UPDATE's WHERE clause on the state
// this call actually read makes the second UPDATE match zero rows instead of
// silently "succeeding" a second time, so the race has one winner instead of
// two -- the loser throws ConcurrentTransitionError and its caller treats
// this run as superseded rather than continuing to act on a card another
// dispatcher already claimed.
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
    .where(and(eq(cards.id, input.cardId), eq(cards.state, fromState)))
    .returning();

  if (!updated) {
    throw new ConcurrentTransitionError(input.cardId, fromState, input.toState);
  }

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

export class CardNotFoundError extends Error {
  constructor(cardId: string) {
    super(`card not found: ${cardId}`);
  }
}

// Thrown when a card has no declared forward edge (NEXT_STATE) to advance
// into -- either it's in a terminal state (done, cancelled) or a state
// that's otherwise not part of the "move to next step" happy path.
export class NoNextStateError extends Error {
  constructor(cardId: string, state: CardState) {
    super(`card ${cardId} has no next step from state "${state}"`);
  }
}

export interface AdvanceCardInput {
  cardId: string;
  actorType: ApplyTransitionInput["actorType"];
  actorId?: string;
}

// Backs the card detail page's "move to next step" button: resolves the
// card's current state to its single forward edge (see getNextState) and
// runs it through the exact same applyTransition write path drag-and-drop
// uses -- same UPDATE ... WHERE state=fromState guard, same card.moved
// event, so orchestrator triggers and history logging fire identically to a
// manual drag. No gating beyond what applyTransition/canTransition already
// enforce -- getNextState can only ever produce a real TRANSITIONS edge.
export async function advanceCard(input: AdvanceCardInput) {
  const [card] = await db.select().from(cards).where(eq(cards.id, input.cardId));
  if (!card) throw new CardNotFoundError(input.cardId);

  const fromState = card.state as CardState;
  const toState = getNextState(fromState);
  if (!toState) throw new NoNextStateError(input.cardId, fromState);

  return applyTransition({ cardId: input.cardId, toState, actorType: input.actorType, actorId: input.actorId });
}
