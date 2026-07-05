import type { cards } from "@loopeng/db";

type Card = typeof cards.$inferSelect;

export interface SkillContext {
  title: string;
  body: string;
}

export interface SpecDocContext {
  title: string;
  body: string;
}

export interface AnsweredQuestionContext {
  question: string;
  answer: string;
}

function formatSpecDocsBlock(specDocs: SpecDocContext[]): string {
  return specDocs.length
    ? specDocs.map((d) => `### Spec: ${d.title}\n${d.body}`).join("\n\n")
    : "(no linked spec docs found)";
}

// Parallel to the reviewer's existing VERDICT: convention — documented in
// every role's instructions so an agent that hits something only a human (or
// later, a manager agent) can resolve escalates instead of guessing or
// reporting failure.
const QUESTION_CONVENTION = [
  "If you are genuinely blocked on something only a human can resolve — an ambiguous requirement,",
  "conflicting instructions, or a judgment call outside the acceptance criteria — do not guess and",
  "do not report failure. Instead, end your entire turn with a line in this exact form, and nothing",
  "else after it:",
  "QUESTION: <your question>",
  "This pauses the card for a human to answer; your question and their answer will be included in",
  "your next dispatch. Only use this for genuine blockers, not to avoid making reasonable decisions.",
].join("\n");

function formatAnsweredQuestionsBlock(answeredQuestions: AnsweredQuestionContext[]): string[] {
  if (answeredQuestions.length === 0) return [];
  return [
    "",
    "## Previous questions & answers",
    ...answeredQuestions.map((qa) => `Previously asked: ${qa.question}\nAnswer: ${qa.answer}`),
  ];
}

export function buildImplementerPrompt(
  card: Card,
  skills: SkillContext[],
  priorFailureNote?: string,
  specDocs: SpecDocContext[] = [],
  answeredQuestions: AnsweredQuestionContext[] = [],
): string {
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
    "## Acceptance criteria",
    card.acceptanceCriteria.length
      ? card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "(none specified)",
    "",
    "## Linked spec docs",
    formatSpecDocsBlock(specDocs),
    "",
    "## Relevant skill docs",
    skillsBlock,
    ...formatAnsweredQuestionsBlock(answeredQuestions),
    ...(priorFailureNote
      ? ["", "## Previous attempt feedback", "A prior attempt at this card was rejected. Address this before continuing:", priorFailureNote]
      : []),
    "",
    "## Instructions",
    "Implement this card end-to-end: write the code, add/update tests, and run the test suite",
    "before finishing. When you are done, commit your changes on the current branch with a clear",
    "commit message. Do not push and do not touch files outside this worktree.",
    "",
    QUESTION_CONVENTION,
  ].join("\n");
}

export function buildPlannerPrompt(requestText: string, existingCardTitles: string[] = []): string {
  return [
    "You are the planner (PM) agent on an internal dev-team platform. A product owner has sent",
    "a freeform request. Your job is to turn it into a spec doc and a decomposition into an epic",
    "plus feature/bug/chore/spike cards. The cards are boarded in backlog state for a human to",
    "review before an implementer agent picks any of them up. You do not write code and you do",
    "not have file or shell tools — your entire output is the two fenced blocks described below.",
    "",
    "## Product owner request",
    requestText,
    "",
    "## Existing open cards on this board (avoid duplicating work already tracked)",
    existingCardTitles.length ? existingCardTitles.map((t) => `- ${t}`).join("\n") : "(none)",
    "",
    "## Output format",
    "Respond with exactly two fenced blocks, in this order, and nothing else outside them.",
    "",
    "1. A ```markdown block containing the spec doc body (no frontmatter, start directly with",
    '   headings like "## Summary"). This becomes the spec doc every decomposed card links back',
    "   to for context — write it so an implementer agent who has never seen this request can",
    "   understand the goal, motivation, and design from this doc alone.",
    "",
    "2. A ```json block containing the decomposition, matching this shape exactly:",
    "```json",
    "{",
    '  "epic": { "title": string, "description": string },',
    '  "cards": [',
    "    {",
    '      "key": string,               // short unique key within this batch, e.g. "auth-api";',
    "                                    // referenced by other cards' dependsOn, never sent to the board",
    '      "title": string,',
    '      "description": string,',
    '      "cardType": "feature" | "bug" | "chore" | "spike",',
    '      "riskTier": "low" | "medium" | "high",',
    '      "priority": number,          // 1 (highest) - 5 (lowest)',
    '      "tags": string[],',
    '      "acceptanceCriteria": string[],',
    '      "dependsOn": string[]        // keys of other cards in this batch that must be done',
    "                                    // first (blocking dependencies); [] if none",
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "## Instructions",
    "Break the request into the smallest independently-shippable cards you can, each with",
    "concrete acceptance criteria. Every card must have at least one acceptance criterion.",
    "Set riskTier per card based on blast radius (touches auth/billing/data-loss -> high;",
    "isolated/reversible -> low). Only add a dependsOn edge when a card genuinely cannot start",
    "before another finishes — over-linking serializes work that could run in parallel.",
  ].join("\n");
}

export function buildReviewerPrompt(card: Card, diff: string, specDocs: SpecDocContext[] = []): string {
  const criteria = card.acceptanceCriteria;

  const checklistInstructions = criteria.length
    ? [
        "Before verdict, verify each acceptance-criteria item individually. For every item",
        "listed under '## Acceptance criteria' above, output a line in this exact form:",
        "CRITERION: <the exact criterion text> -> SATISFIED",
        "or",
        "CRITERION: <the exact criterion text> -> NOT SATISFIED",
        "",
        `You must emit exactly ${criteria.length} CRITERION line(s), one per acceptance-criteria`,
        "item, in the order listed. Base each verdict strictly on evidence in the diff — do not",
        "mark an item SATISFIED unless the diff demonstrably implements it.",
        "",
        "If any CRITERION line is marked NOT SATISFIED, the final verdict must be VERDICT: FAIL.",
        "Only output VERDICT: PASS if every CRITERION line is marked SATISFIED and there are no",
        "other correctness problems.",
      ]
    : ["No acceptance criteria were specified for this card, so no CRITERION lines are required."];

  return [
    "You are the reviewer agent on an internal dev-team platform, performing sub-agent",
    "verification of another agent's work before it proceeds to the gate pipeline. You are",
    "read-only: you cannot edit or write files in this session.",
    "",
    `## Card: ${card.title}`,
    card.description ? card.description : "(no description provided)",
    "",
    "## Acceptance criteria",
    criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : "(none specified)",
    "",
    "## Linked spec docs",
    formatSpecDocsBlock(specDocs),
    "",
    "## Diff to review",
    "```diff",
    diff || "(no diff — no changes were made)",
    "```",
    "",
    "## Instructions",
    "Review the diff against the card's requirements. Check for correctness, missed edge cases,",
    "and whether tests were added/updated.",
    "",
    checklistInstructions.join("\n"),
    "",
    "Then, as the very last line of your response, output exactly one of:",
    "VERDICT: PASS",
    "VERDICT: FAIL",
  ].join("\n");
}

export function buildDesignerSpecPrompt(card: Card): string {
  return [
    "You are the designer agent on an internal dev-team platform, producing an upstream design",
    "spec for a UI/UX-touching card before the implementer starts work. You are read-only: you",
    "cannot edit, write, or run shell commands in this session — explore the existing codebase",
    "with your read/search tools only.",
    "",
    `## Card: ${card.title}`,
    card.description ? card.description : "(no description provided)",
    "",
    `Card type: ${card.cardType} | Risk tier: ${card.riskTier}`,
    "",
    "## Acceptance criteria",
    card.acceptanceCriteria.length
      ? card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "(none specified)",
    "",
    "## Instructions",
    "Explore the existing apps/web and packages/ui code to see what layout patterns, components,",
    "and design tokens already exist. Then write a short design spec covering:",
    "- Layout approach for this card",
    "- Which existing packages/ui components and design tokens to reuse (name them specifically —",
    "  prefer reuse over new one-off markup)",
    "- Interaction states: loading, empty, and error",
    "- Basic accessibility notes (focus order, labels, contrast)",
    "",
    "Respond with exactly one fenced block and nothing else outside it:",
    "```markdown",
    "<your design spec>",
    "```",
  ].join("\n");
}

export function buildDesignerReviewPrompt(card: Card, diff: string, specDocs: SpecDocContext[] = []): string {
  return [
    "You are the designer agent on an internal dev-team platform, performing a design review of",
    "another agent's UI/UX work in parallel with peer code review. You are read-only: you cannot",
    "edit or write files in this session.",
    "",
    `## Card: ${card.title}`,
    card.description ? card.description : "(no description provided)",
    "",
    "## Linked spec docs",
    formatSpecDocsBlock(specDocs),
    "",
    "## Diff to review",
    "```diff",
    diff || "(no diff — no changes were made)",
    "```",
    "",
    "## Instructions",
    "Review the diff for:",
    "- Design-system token usage vs hardcoded style values (colors, spacing, font sizes)",
    "- Component reuse vs one-off markup that duplicates an existing packages/ui component",
    "- Obvious responsive or accessibility regressions",
    "",
    "Then, as the very last line of your response, output exactly one of:",
    "VERDICT: PASS",
    "VERDICT: FAIL",
  ].join("\n");
}
