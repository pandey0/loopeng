import { and, eq } from "drizzle-orm";
import { agentRoles, agentRuns, cardDependencies, cards, db } from "@loopeng/db";

// Parses the QUESTION: convention (packages/agents/src/prompts.ts documents
// it to the agent, parallel to the existing VERDICT: convention reviewers
// use) out of a completed run's result text. An agent that is genuinely
// blocked ends its entire turn with this instead of a low-confidence guess
// or a reported failure, so the orchestrator can pause the card visibly
// rather than counting it as a failed attempt.
export function extractQuestion(resultText: string): string | null {
  const match = /QUESTION:/i.exec(resultText);
  if (!match) return null;
  const question = resultText.slice(match.index + match[0].length).trim();
  return question.length > 0 ? question : null;
}

export type QuestionRouteTarget = "product_owner" | "tech-manager";

// A child card's QUESTION routes to whichever manager reviewed its parent
// epic (spec: org-chart-manager-agent-role) — v1 has exactly one manager
// type, so "was reviewed by a manager" is just "has a successful
// tech-manager agent run", found by walking the relates_to edge the
// planner/manager decomposition always creates from child card -> epic.
// Falls back to the product owner for cards with no epic, or an epic no
// manager has reviewed (yet, or ever, for boards seeded before this card).
export async function resolveQuestionRouting(cardId: string): Promise<QuestionRouteTarget> {
  const [epicEdge] = await db
    .select({ epicCardId: cardDependencies.dependsOnCardId })
    .from(cardDependencies)
    .innerJoin(cards, eq(cardDependencies.dependsOnCardId, cards.id))
    .where(
      and(
        eq(cardDependencies.cardId, cardId),
        eq(cardDependencies.dependencyType, "relates_to"),
        eq(cards.cardType, "epic"),
      ),
    );
  if (!epicEdge) return "product_owner";

  const [managerRun] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(agentRoles, eq(agentRuns.agentRoleId, agentRoles.id))
    .where(
      and(
        eq(agentRuns.cardId, epicEdge.epicCardId),
        eq(agentRoles.name, "tech-manager"),
        eq(agentRuns.status, "succeeded"),
      ),
    );
  return managerRun ? "tech-manager" : "product_owner";
}
