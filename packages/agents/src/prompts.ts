import type { cards } from "@loopeng/db";

type Card = typeof cards.$inferSelect;

export interface SkillContext {
  title: string;
  body: string;
}

export function buildImplementerPrompt(card: Card, skills: SkillContext[], priorFailureNote?: string): string {
  const skillsBlock = skills.length
    ? skills.map((s) => `### Skill: ${s.title}\n${s.body}`).join("\n\n")
    : "(no relevant skill docs found)";

  return [
    "You are the implementer agent on an internal dev-team platform. You have been assigned the",
    "following kanban card. Work inside this worktree only — it is an isolated git branch checked",
    "out just for this card.",
    "",
    `## Card: ${card.title}`,
    card.description ? card.description : "(no description provided)",
    "",
    `Card type: ${card.cardType} | Risk tier: ${card.riskTier}`,
    "",
    "## Relevant skill docs",
    skillsBlock,
    ...(priorFailureNote
      ? ["", "## Previous attempt feedback", "A prior attempt at this card was rejected. Address this before continuing:", priorFailureNote]
      : []),
    "",
    "## Instructions",
    "Implement this card end-to-end: write the code, add/update tests, and run the test suite",
    "before finishing. When you are done, commit your changes on the current branch with a clear",
    "commit message. Do not push and do not touch files outside this worktree.",
  ].join("\n");
}

export function buildReviewerPrompt(card: Card, diff: string): string {
  return [
    "You are the reviewer agent on an internal dev-team platform, performing sub-agent",
    "verification of another agent's work before it proceeds to the gate pipeline. You are",
    "read-only: you cannot edit or write files in this session.",
    "",
    `## Card: ${card.title}`,
    card.description ? card.description : "(no description provided)",
    "",
    "## Diff to review",
    "```diff",
    diff || "(no diff — no changes were made)",
    "```",
    "",
    "## Instructions",
    "Review the diff against the card's requirements. Check for correctness, missed edge cases,",
    "and whether tests were added/updated. Then, as the very last line of your response, output",
    "exactly one of:",
    "VERDICT: PASS",
    "VERDICT: FAIL",
  ].join("\n");
}
