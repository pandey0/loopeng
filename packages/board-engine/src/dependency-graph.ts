import { and, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { cardDependencies, cards } from "@loopeng/db";

export async function isReady(cardId: string): Promise<boolean> {
  const blockers = await db
    .select()
    .from(cardDependencies)
    .where(and(eq(cardDependencies.cardId, cardId), eq(cardDependencies.dependencyType, "blocks")));

  if (blockers.length === 0) return true;

  for (const blocker of blockers) {
    const [dep] = await db.select().from(cards).where(eq(cards.id, blocker.dependsOnCardId));
    if (!dep || dep.state !== "done") return false;
  }
  return true;
}

/**
 * Would inserting `cardId depends_on dependsOnCardId` create a cycle?
 * True iff dependsOnCardId can already reach cardId by following existing
 * "depends_on" edges — i.e. cardId is a (possibly transitive) dependency of
 * dependsOnCardId already.
 */
export async function wouldCreateCycle(cardId: string, dependsOnCardId: string): Promise<boolean> {
  if (cardId === dependsOnCardId) return true;

  const visited = new Set<string>();
  const stack = [dependsOnCardId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (current === cardId) return true;

    const edges = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, current));
    for (const edge of edges) {
      stack.push(edge.dependsOnCardId);
    }
  }
  return false;
}

export interface DependencyEdge {
  cardId: string;
  dependsOnCardId: string;
}

/**
 * Topological order of a board's cards, dependency-first (a card only
 * appears once every card it "blocks"-depends on already appears earlier).
 * Used by automations to process unblocked cards before blocked ones.
 * Throws if the board's dependency graph contains a cycle.
 */
export async function topoSort(boardId: string): Promise<string[]> {
  const boardCards = await db.select().from(cards).where(eq(cards.boardId, boardId));
  const cardIds = new Set(boardCards.map((c) => c.id));

  const edges: DependencyEdge[] = [];
  for (const cardId of cardIds) {
    const rows = await db
      .select()
      .from(cardDependencies)
      .where(and(eq(cardDependencies.cardId, cardId), eq(cardDependencies.dependencyType, "blocks")));
    for (const row of rows) {
      if (cardIds.has(row.dependsOnCardId)) {
        edges.push({ cardId: row.cardId, dependsOnCardId: row.dependsOnCardId });
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of cardIds) inDegree.set(id, 0);
  for (const edge of edges) {
    inDegree.set(edge.cardId, (inDegree.get(edge.cardId) ?? 0) + 1);
    dependents.set(edge.dependsOnCardId, [...(dependents.get(edge.dependsOnCardId) ?? []), edge.cardId]);
  }

  const queue = [...cardIds].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (order.length !== cardIds.size) {
    throw new Error(`dependency cycle detected on board ${boardId}`);
  }
  return order;
}
