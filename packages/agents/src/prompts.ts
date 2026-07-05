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

// Shared by the planner (fresh intake) and the manager (epic review) — both
// emit a spec doc + decomposition pair in the exact shape parsePlannerOutput
// expects, just from different starting contexts.
const DECOMPOSITION_OUTPUT_FORMAT = [
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
].join("\n");

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
    DECOMPOSITION_OUTPUT_FORMAT,
    "",
    "## Instructions",
    "Break the request into the smallest independently-shippable cards you can, each with",
    "concrete acceptance criteria. Every card must have at least one acceptance criterion.",
    "Set riskTier per card based on blast radius (touches auth/billing/data-loss -> high;",
    "isolated/reversible -> low). Only add a dependsOn edge when a card genuinely cannot start",
    "before another finishes — over-linking serializes work that could run in parallel.",
  ].join("\n");
}

export interface ManagerChildCardContext {
  key: string;
  title: string;
  description: string | null;
  cardType: string;
  riskTier: string;
  priority: number;
  tags: string[];
  acceptanceCriteria: string[];
}

// The manager gets exactly one shot at this, right after intake creates the
// epic (spec: org-chart-manager-agent-role) — it is not a standing process,
// so it must commit to a final breakdown in this single turn rather than
// asking the epic to keep coming back.
export function buildManagerPrompt(epic: Card, childCards: ManagerChildCardContext[], specDocs: SpecDocContext[] = []): string {
  const childCardsBlock = childCards
    .map((c) =>
      [
        `### ${c.key}: ${c.title}`,
        `type=${c.cardType} risk=${c.riskTier} priority=${c.priority} tags=${c.tags.join(",") || "(none)"}`,
        c.description ?? "(no description)",
        c.acceptanceCriteria.length ? c.acceptanceCriteria.map((a) => `- ${a}`).join("\n") : "(no acceptance criteria)",
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "You are the tech-manager agent on an internal dev-team platform. A planner agent just",
    "decomposed a product owner's request into this epic and its child cards. Your job is to",
    "review that breakdown once and, if needed, adjust it — split a card that bundles too much,",
    "merge cards that are really one unit of work, reprioritize, or correct a risk tier. You do",
    "not write code and do not have file or shell tools — your entire output is the two fenced",
    "blocks described below. You are also the escalation contact these child cards will route",
    "QUESTION:s to going forward, so make sure the breakdown you leave behind is one you'd be",
    "comfortable fielding questions about.",
    "",
    `## Epic: ${epic.title}`,
    epic.description ?? "(no description provided)",
    "",
    "## Linked spec docs",
    formatSpecDocsBlock(specDocs),
    "",
    "## Current child cards (as decomposed by the planner)",
    childCardsBlock || "(none)",
    "",
    DECOMPOSITION_OUTPUT_FORMAT,
    "",
    "## Instructions",
    'The "epic" field in your JSON output is not used to create a new epic — restate this epic\'s',
    "title and description in it. The full \"cards\" array you output *replaces* the current child",
    "cards listed above, so include every card that should still exist (unchanged ones included",
    "verbatim) plus any you're adding, splitting, or merging in. If the current breakdown is",
    "already good, it is fine to return it unchanged.",
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
