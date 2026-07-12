import type { CardWithStatus } from "@loopeng/shared";

// Substring, case-insensitive match on title only (not description/body),
// per the board search spec. An empty/whitespace-only query is "no filter"
// rather than "match nothing".
export function filterCardsByTitle<T extends Pick<CardWithStatus, "title">>(cards: T[], query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return cards;
  return cards.filter((c) => c.title.toLowerCase().includes(trimmed));
}

// True once a query has been entered but it matched nothing -- the signal
// the board uses to swap ten empty columns for a single "no cards match"
// message instead. Clears the instant the query is emptied or edited to
// something that matches again, since it's recomputed from current state.
export function hasNoMatches(query: string, visibleCards: unknown[]): boolean {
  return query.trim().length > 0 && visibleCards.length === 0;
}
