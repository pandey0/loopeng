import { z } from "zod";
import { cardDependencies, cardDocLinks, cards, db } from "@loopeng/db";
import { createDoc } from "@loopeng/doc-engine";
import { PLANNER_CHILD_CARD_TYPES, RISK_TIERS, type RiskTier } from "@loopeng/shared";

export class PlannerOutputError extends Error {}

export const PlannerCardSpecSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  cardType: z.enum(PLANNER_CHILD_CARD_TYPES),
  riskTier: z.enum(RISK_TIERS),
  priority: z.number().int().min(1).max(5).default(3),
  tags: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
});
export type PlannerCardSpec = z.infer<typeof PlannerCardSpecSchema>;

export const PlannerDecompositionSchema = z.object({
  epic: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
  }),
  cards: z.array(PlannerCardSpecSchema).min(1),
});
export type PlannerDecomposition = z.infer<typeof PlannerDecompositionSchema>;

export interface ParsedPlannerOutput {
  specBody: string;
  decomposition: PlannerDecomposition;
}

// Follows a stricter-parsed variant of the reviewer's "grep the resultText
// for a marker" approach: the model is instructed to emit exactly one
// ```markdown spec block and one ```json decomposition block, and this
// parses/validates both deterministically rather than letting the model's
// tool calls mutate the board directly.
export function parsePlannerOutput(resultText: string): ParsedPlannerOutput {
  const specMatch = resultText.match(/```markdown\s*\n([\s\S]*?)```/);
  if (!specMatch) {
    throw new PlannerOutputError("planner output missing a ```markdown spec doc block");
  }

  const jsonMatch = resultText.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) {
    throw new PlannerOutputError("planner output missing a ```json decomposition block");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonMatch[1]!);
  } catch (err) {
    throw new PlannerOutputError(`planner decomposition block is not valid JSON: ${(err as Error).message}`);
  }

  const result = PlannerDecompositionSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new PlannerOutputError(`planner decomposition failed schema validation: ${result.error.message}`);
  }
  const decomposition = result.data;

  const keys = new Set(decomposition.cards.map((c) => c.key));
  if (keys.size !== decomposition.cards.length) {
    throw new PlannerOutputError("planner decomposition has duplicate card keys");
  }
  for (const card of decomposition.cards) {
    for (const dep of card.dependsOn) {
      if (dep === card.key) {
        throw new PlannerOutputError(`card "${card.key}" cannot depend on itself`);
      }
      if (!keys.has(dep)) {
        throw new PlannerOutputError(`card "${card.key}" depends on unknown key "${dep}"`);
      }
    }
  }

  const cycle = findDependencyCycle(decomposition.cards);
  if (cycle) {
    throw new PlannerOutputError(`planner decomposition has a dependency cycle: ${cycle.join(" -> ")}`);
  }

  return { specBody: specMatch[1]!.trim(), decomposition };
}

// Batch-local cycle check (DFS with a recursion stack) over the "dependsOn"
// keys the model emitted — runs before any DB write so a self-contradictory
// decomposition fails the whole run instead of landing half-inserted cards.
export function findDependencyCycle(cardsSpec: PlannerCardSpec[]): string[] | null {
  const byKey = new Map(cardsSpec.map((c) => [c.key, c]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function visit(key: string): string[] | null {
    const status = state.get(key);
    if (status === "done") return null;
    if (status === "visiting") {
      const cycleStart = path.indexOf(key);
      return [...path.slice(cycleStart), key];
    }
    state.set(key, "visiting");
    path.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    state.set(key, "done");
    return null;
  }

  for (const card of cardsSpec) {
    const found = visit(card.key);
    if (found) return found;
  }
  return null;
}

const RISK_ORDER: RiskTier[] = [...RISK_TIERS];

// The epic tracks its riskiest child so a high-risk card buried in the
// decomposition can't hide behind an epic that reads as low risk.
export function computeEpicRiskTier(cardsSpec: PlannerCardSpec[]): RiskTier {
  return cardsSpec.reduce<RiskTier>(
    (max, card) => (RISK_ORDER.indexOf(card.riskTier) > RISK_ORDER.indexOf(max) ? card.riskTier : max),
    "low",
  );
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50);
}

export interface PersistDecompositionOptions {
  authorId?: string;
}

export interface PersistedDecomposition {
  epicCardId: string;
  cardIds: string[];
  specDocId: string;
}

// Writes a validated planner decomposition to the board: one spec doc (the
// markdown block, committed through doc-engine so it gets the same
// git-backed history as a human-authored doc), one epic card, and one card
// per decomposition entry, each spec-linked to the doc, related to the epic,
// and blocked on its declared dependsOn keys. Every card lands (and stays)
// in "backlog" — this is an intake tool, not an auto-approval bypass, so a
// human reviews and moves cards to "ready" themselves before dispatch.
export async function persistDecomposition(
  boardId: string,
  parsed: ParsedPlannerOutput,
  opts: PersistDecompositionOptions = {},
): Promise<PersistedDecomposition> {
  const { specBody, decomposition } = parsed;
  const epicRiskTier = computeEpicRiskTier(decomposition.cards);

  const slug = `intake-${slugifyTitle(decomposition.epic.title)}-${Date.now().toString(36)}`;
  const specDoc = await createDoc({
    slug,
    title: `Spec: ${decomposition.epic.title}`,
    docType: "wiki",
    content: specBody,
    tags: ["intake", "planner"],
    authorId: opts.authorId,
    message: `planner intake: ${decomposition.epic.title}`,
  });

  const [epicCard] = await db
    .insert(cards)
    .values({
      boardId,
      title: decomposition.epic.title,
      description: decomposition.epic.description,
      cardType: "epic",
      riskTier: epicRiskTier,
      tags: ["planner-generated"],
    })
    .returning();
  if (!epicCard) throw new PlannerOutputError("failed to insert epic card");

  await db.insert(cardDocLinks).values({ cardId: epicCard.id, docId: specDoc.id, linkType: "spec" });

  const idByKey = new Map<string, string>();
  for (const spec of decomposition.cards) {
    const [card] = await db
      .insert(cards)
      .values({
        boardId,
        title: spec.title,
        description: spec.description,
        cardType: spec.cardType,
        riskTier: spec.riskTier,
        priority: spec.priority,
        tags: spec.tags,
        acceptanceCriteria: spec.acceptanceCriteria,
      })
      .returning();
    if (!card) throw new PlannerOutputError(`failed to insert card for key "${spec.key}"`);
    idByKey.set(spec.key, card.id);

    await db.insert(cardDocLinks).values({ cardId: card.id, docId: specDoc.id, linkType: "spec" });
    await db.insert(cardDependencies).values({ cardId: card.id, dependsOnCardId: epicCard.id, dependencyType: "relates_to" });
  }

  for (const spec of decomposition.cards) {
    const cardId = idByKey.get(spec.key)!;
    for (const dep of spec.dependsOn) {
      await db.insert(cardDependencies).values({
        cardId,
        dependsOnCardId: idByKey.get(dep)!,
        dependencyType: "blocks",
      });
    }
  }

  const cardIds = decomposition.cards.map((spec) => idByKey.get(spec.key)!);

  return { epicCardId: epicCard.id, cardIds, specDocId: specDoc.id };
}
