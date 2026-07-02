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

function formatSpecDocsBlock(specDocs: SpecDocContext[]): string {
  return specDocs.length
    ? specDocs.map((d) => `### Spec: ${d.title}\n${d.body}`).join("\n\n")
    : "(no linked spec docs found)";
}

export function buildImplementerPrompt(
  card: Card,
  skills: SkillContext[],
  priorFailureNote?: string,
  specDocs: SpecDocContext[] = [],
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

export function buildPlannerPrompt(requestText: string, existingCardTitles: string[] = []): string {
  return [
    "You are the planner (PM) agent on an internal dev-team platform. A product owner has sent",
    "a freeform request. Your job is to turn it into a spec doc and a decomposition into an epic",
    "plus feature/bug/chore/spike cards, ready to be boarded for autonomous pickup by an",
    "implementer agent. You do not write code and you do not have file or shell tools — your",
    "entire output is the two fenced blocks described below.",
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
