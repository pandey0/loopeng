import type { cards } from "@loopeng/db";

type Card = typeof cards.$inferSelect;

// Prompts carry only this much per linked doc — slug + one-line frontmatter
// summary, not the full body (RFC: rfc/2026-07-obsidian-vault-token-efficiency).
// An agent that needs more fetches it on demand with the get_doc(slug) MCP tool.
export interface SkillContext {
  slug: string;
  title: string;
  summary: string;
}

export interface SpecDocContext {
  slug: string;
  title: string;
  summary: string;
}

export interface AnsweredQuestionContext {
  question: string;
  answer: string;
}

// Documented once, inlined into every role prompt that lists doc summaries, so
// an agent knows how to go from a one-liner to the full text when it needs it.
const GET_DOC_CONVENTION = [
  "Docs above are listed as a slug and a one-line summary only, to keep this prompt small — not",
  "the full text. If a summary suggests a doc has detail relevant to your task, fetch its full",
  'text with the `get_doc` MCP tool (call it with { "slug": "<slug>" }) before acting on it.',
  "Don't guess at a doc's contents from its summary alone when the task depends on getting it right.",
].join("\n");

function formatDocSummaryLine(d: { slug: string; title: string; summary: string }): string {
  return `- \`${d.slug}\` (${d.title}): ${d.summary}`;
}

function formatSpecDocsBlock(specDocs: SpecDocContext[]): string {
  return specDocs.length ? specDocs.map(formatDocSummaryLine).join("\n") : "(no linked spec docs found)";
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
  const skillsBlock = skills.length ? skills.map(formatDocSummaryLine).join("\n") : "(no relevant skill docs found)";

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
    "",
    GET_DOC_CONVENTION,
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
    GET_DOC_CONVENTION,
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
