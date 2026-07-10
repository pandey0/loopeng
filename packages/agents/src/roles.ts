import { and, desc, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import {
  agentRoles,
  agentRuns,
  boards,
  cardDependencies,
  cardDocLinks,
  cardQuestions,
  cards,
  docs as docsTable,
  projects,
} from "@loopeng/db";
import { createDoc, listDocs } from "@loopeng/doc-engine";

type Card = typeof cards.$inferSelect;
import { getActiveWorktree, getRepoDiff, resolveRepoRoot } from "@loopeng/worktree-manager";
import { runClaudeCliStreamingOnce } from "./claude-cli.js";
import {
  parsePlannerOutput,
  persistDecomposition,
  persistManagerDecomposition,
  PlannerOutputError,
  type PersistedDecomposition,
  type PersistedManagerDecomposition,
} from "./decomposition.js";
import { writeAgentLog } from "./logs.js";
import {
  buildDesignerReviewPrompt,
  buildDesignerSpecPrompt,
  buildImplementerPrompt,
  buildIntegratorPrompt,
  buildManagerPrompt,
  buildPlannerPrompt,
  buildProjectAnalyzerPrompt,
  buildReviewerPrompt,
  type AnsweredQuestionContext,
  type ManagerChildCardContext,
  type SkillContext,
  type SpecDocContext,
} from "./prompts.js";
import { extractQuestion } from "./questions.js";
import { buildSubAgentMcpConfig } from "./sub-agent.js";

export interface AgentRunResult {
  agentRunId: string;
  isError: boolean;
  resultText: string;
  costUsd?: number;
  logsRef: string;
  /** Set when the run ended its turn with the QUESTION: convention instead of finishing normally. */
  question?: string;
}

// Injected into the next dispatch's prompt (buildImplementerPrompt) so the
// agent can see how a question it (or a previous attempt) raised was
// answered. Capped rather than tracking per-question "consumed" state —
// simpler, and acceptable given typical card lifetime (spec: card-questions-escalation).
const MAX_ANSWERED_QUESTIONS_IN_PROMPT = 5;

async function loadAnsweredQuestions(cardId: string): Promise<AnsweredQuestionContext[]> {
  const rows = await db
    .select({ question: cardQuestions.question, answer: cardQuestions.answer })
    .from(cardQuestions)
    .where(and(eq(cardQuestions.cardId, cardId), eq(cardQuestions.status, "answered")))
    .orderBy(desc(cardQuestions.answeredAt))
    .limit(MAX_ANSWERED_QUESTIONS_IN_PROMPT);

  return rows.filter((r): r is { question: string; answer: string } => r.answer !== null).reverse();
}

export interface ReviewerRunResult extends AgentRunResult {
  verdict: "pass" | "fail";
}

// Prompts only need slug + one-line summary per doc (lazy retrieval — see
// prompts.ts's GET_DOC_CONVENTION), so this stays a plain DB read: no git
// read, no getDoc() call, for every doc linked/tagged onto a card.
async function loadRelevantSkills(card: Card): Promise<SkillContext[]> {
  const skillDocs = await listDocs({ docType: "skill" });
  const tagMatched = skillDocs.filter((doc) => doc.tags.some((t) => card.tags.includes(t)));

  const linkedRows = await db
    .select()
    .from(cardDocLinks)
    .innerJoin(docsTable, eq(cardDocLinks.docId, docsTable.id))
    .where(and(eq(cardDocLinks.cardId, card.id), eq(cardDocLinks.linkType, "skill")));

  const byId = new Map(tagMatched.map((d) => [d.id, d]));
  for (const row of linkedRows) byId.set(row.docs.id, row.docs);

  return Array.from(byId.values()).map((doc) => ({ slug: doc.slug, title: doc.title, summary: doc.summary }));
}

async function loadLinkedSpecDocs(card: Card): Promise<SpecDocContext[]> {
  const linkedRows = await db
    .select()
    .from(cardDocLinks)
    .innerJoin(docsTable, eq(cardDocLinks.docId, docsTable.id))
    .where(and(eq(cardDocLinks.cardId, card.id), eq(cardDocLinks.linkType, "spec")));

  return linkedRows.map((row) => ({ slug: row.docs.slug, title: row.docs.title, summary: row.docs.summary }));
}

// The analyzer agent's project-brief doc, prepended ahead of a card's own
// linked spec docs wherever this is called — it's the broadest context
// (whole-repo), so it reads first. Only surfaces once briefStatus is
// "ready": while analysis is still running (or failed), there's nothing
// real to hand the agent, and a half-written brief would be worse than none.
async function loadProjectBriefForBoard(boardId: string): Promise<SpecDocContext[]> {
  const [row] = await db
    .select({ doc: docsTable })
    .from(boards)
    .innerJoin(projects, eq(boards.projectId, projects.id))
    .innerJoin(docsTable, eq(projects.briefDocId, docsTable.id))
    .where(and(eq(boards.id, boardId), eq(projects.briefStatus, "ready")));
  if (!row) return [];
  return [{ slug: row.doc.slug, title: row.doc.title, summary: row.doc.summary }];
}

async function loadProjectBrief(card: Card): Promise<SpecDocContext[]> {
  return loadProjectBriefForBoard(card.boardId);
}

// The planner has no card yet (it's what produces one), so there's nothing to
// filter doc relevance by tags/links — it gets every existing RFC/ADR and
// skill doc as slug + one-line summary instead, same lazy get_doc contract as
// the other roles, so it can spot prior decisions before proposing new ones.
async function loadAllSpecDocs(): Promise<SpecDocContext[]> {
  const [rfcs, adrs] = await Promise.all([listDocs({ docType: "rfc" }), listDocs({ docType: "adr" })]);
  return [...rfcs, ...adrs].map((doc) => ({ slug: doc.slug, title: doc.title, summary: doc.summary }));
}

async function loadAllSkillDocs(): Promise<SkillContext[]> {
  const skillDocs = await listDocs({ docType: "skill" });
  return skillDocs.map((doc) => ({ slug: doc.slug, title: doc.title, summary: doc.summary }));
}

export async function getRoleId(name: string): Promise<string> {
  const [role] = await db.select().from(agentRoles).where(eq(agentRoles.name, name));
  if (!role) throw new Error(`agent role not seeded: ${name}`);
  return role.id;
}

export async function runImplementerAgent(card: Card, priorFailureNote?: string): Promise<AgentRunResult> {
  const worktree = await getActiveWorktree(card.id);
  if (!worktree) throw new Error(`no active worktree for card ${card.id}`);

  const roleId = await getRoleId("implementer");
  const skills = await loadRelevantSkills(card);
  const specDocs = [...(await loadProjectBrief(card)), ...(await loadLinkedSpecDocs(card))];
  const answeredQuestions = await loadAnsweredQuestions(card.id);
  const prompt = buildImplementerPrompt(card, skills, priorFailureNote, specDocs, answeredQuestions);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: card.id, agentRoleId: roleId, worktreeId: worktree.id, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  // bypassPermissions, not acceptEdits: headless mode has no TTY to prompt for
  // Bash approval, so acceptEdits (edits only) silently blocks git commit and
  // test runs — the agent reports success but never actually finishes. The
  // worktree is the real isolation boundary here (a physically separate
  // checkout the agent cwd is pinned to), so full autonomy inside it is safe.
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: card.id,
    worktreeId: worktree.id,
    cwd: worktree.fsPath,
    depth: 1,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: worktree.fsPath,
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  // A clean end-of-turn QUESTION: (never on an errored run — that's a crash,
  // not a deliberate escalation) is neither a success nor a failure: the
  // orchestrator pauses the card instead of advancing or retrying.
  const question = !result.isError ? extractQuestion(result.resultText) : null;

  await db
    .update(agentRuns)
    .set({
      status: result.isError ? "failed" : "succeeded",
      logsRef,
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));

  return {
    agentRunId: run.id,
    isError: result.isError,
    resultText: result.resultText,
    costUsd: result.totalCostUsd,
    logsRef,
    question: question ?? undefined,
  };
}

export interface PlannerRunResult extends AgentRunResult, PersistedDecomposition {}

export interface PlannerRunHandle {
  agentRunId: string;
  /** Resolves/rejects once the CLI call, output parsing, and board persistence finish. */
  result: Promise<PlannerRunResult>;
}

// Turns a freeform product-owner request into a boarded epic + child cards.
// Unlike the implementer/reviewer, the planner has no card or worktree yet —
// it runs read-only against the main repo checkout (for codebase context)
// and is never allowed to touch files; its entire output is the two fenced
// blocks parsePlannerOutput expects. On success, the decomposition is
// persisted with every card left in "backlog" — this is an intake tool, not
// an auto-approval bypass, so a human reviews and moves cards to "ready"
// themselves before dispatch.
//
// Split into two halves so an HTTP caller can hand back agentRunId (and let
// the frontend attach a live AgentSessionPanel) as soon as the agent_runs row
// exists, instead of blocking the whole request on the CLI call + parsing +
// persistence, which can take tens of seconds.
export async function startPlannerAgent(boardId: string, requestText: string): Promise<PlannerRunHandle> {
  const roleId = await getRoleId("planner");
  const existingCards = await db.select({ title: cards.title }).from(cards).where(eq(cards.boardId, boardId));
  const [projectBrief, allSpecDocs, skills] = await Promise.all([
    loadProjectBriefForBoard(boardId),
    loadAllSpecDocs(),
    loadAllSkillDocs(),
  ]);
  const prompt = buildPlannerPrompt(
    requestText,
    existingCards.map((c) => c.title),
    [...projectBrief, ...allSpecDocs],
    skills,
  );

  const [run] = await db
    .insert(agentRuns)
    .values({ agentRoleId: roleId, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  return { agentRunId: run.id, result: executePlannerAgent(boardId, run.id, prompt) };
}

async function executePlannerAgent(boardId: string, runId: string, prompt: string): Promise<PlannerRunResult> {
  const plannerDisallowedTools = ["Edit", "Write", "NotebookEdit", "Bash"];
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: runId,
    cardId: null,
    worktreeId: null,
    cwd: resolveRepoRoot(),
    depth: 1,
    disallowedTools: plannerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: resolveRepoRoot(),
    agentRunId: runId,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: plannerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(runId, result.raw);

  if (result.isError) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, runId));
    throw new PlannerOutputError(`planner agent run failed: ${result.resultText.slice(0, 2000)}`);
  }

  let persisted: PersistedDecomposition;
  try {
    const parsed = parsePlannerOutput(result.resultText);
    persisted = await persistDecomposition(boardId, parsed);
  } catch (err) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, runId));
    throw err;
  }

  await db.update(agentRuns).set({ status: "succeeded", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, runId));

  return {
    agentRunId: runId,
    isError: false,
    resultText: result.resultText,
    costUsd: result.totalCostUsd,
    logsRef,
    ...persisted,
  };
}

// Convenience wrapper kept for callers that want the old blocking behavior
// (e.g. scripts, tests) — awaits the entire run instead of just kicking it off.
export async function runPlannerAgent(boardId: string, requestText: string): Promise<PlannerRunResult> {
  const { result } = await startPlannerAgent(boardId, requestText);
  return result;
}

export interface ManagerRunResult extends AgentRunResult, PersistedManagerDecomposition {}

// Reviews a freshly-decomposed epic's child cards and may adjust the
// breakdown (spec: org-chart-manager-agent-role). Runs once, right after
// intake creates the epic — not a persistent standing process. Like the
// planner, it has no card-scoped worktree; it runs read-only against the
// main repo checkout and its entire output is the two fenced blocks
// parsePlannerOutput expects, scoped to this one epic instead of a fresh
// intake request.
export async function runManagerAgent(epicCardId: string): Promise<ManagerRunResult> {
  const [epicCard] = await db.select().from(cards).where(eq(cards.id, epicCardId));
  if (!epicCard) throw new Error(`epic card not found: ${epicCardId}`);
  if (epicCard.cardType !== "epic") {
    throw new Error(`card ${epicCardId} is not an epic (cardType=${epicCard.cardType})`);
  }

  const roleId = await getRoleId("tech-manager");

  const childRows = await db
    .select({ card: cards })
    .from(cardDependencies)
    .innerJoin(cards, eq(cardDependencies.cardId, cards.id))
    .where(and(eq(cardDependencies.dependsOnCardId, epicCardId), eq(cardDependencies.dependencyType, "relates_to")));
  const childCards: ManagerChildCardContext[] = childRows.map(({ card }, i) => ({
    key: `child-${i}`,
    title: card.title,
    description: card.description,
    cardType: card.cardType,
    riskTier: card.riskTier,
    priority: card.priority,
    tags: card.tags,
    acceptanceCriteria: card.acceptanceCriteria,
  }));

  const specDocs = [...(await loadProjectBrief(epicCard)), ...(await loadLinkedSpecDocs(epicCard))];
  const prompt = buildManagerPrompt(epicCard, childCards, specDocs);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: epicCardId, agentRoleId: roleId, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  const managerDisallowedTools = ["Edit", "Write", "NotebookEdit", "Bash"];
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: epicCardId,
    worktreeId: null,
    cwd: resolveRepoRoot(),
    depth: 1,
    disallowedTools: managerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: resolveRepoRoot(),
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: managerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  if (result.isError) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, run.id));
    throw new PlannerOutputError(`manager agent run failed: ${result.resultText.slice(0, 2000)}`);
  }

  let persisted: PersistedManagerDecomposition;
  try {
    const parsed = parsePlannerOutput(result.resultText);
    persisted = await persistManagerDecomposition(epicCardId, parsed);
  } catch (err) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, run.id));
    throw err;
  }

  await db.update(agentRuns).set({ status: "succeeded", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, run.id));

  return {
    agentRunId: run.id,
    isError: false,
    resultText: result.resultText,
    costUsd: result.totalCostUsd,
    logsRef,
    ...persisted,
  };
}

export async function runReviewerAgent(card: Card): Promise<ReviewerRunResult> {
  const worktree = await getActiveWorktree(card.id);
  if (!worktree) throw new Error(`no active worktree for card ${card.id}`);

  const roleId = await getRoleId("reviewer");
  const diff = await getRepoDiff(worktree.fsPath, worktree.baseCommitSha);
  const specDocs = [...(await loadProjectBrief(card)), ...(await loadLinkedSpecDocs(card))];
  const prompt = buildReviewerPrompt(card, diff, specDocs);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: card.id, agentRoleId: roleId, worktreeId: worktree.id, status: "verifying", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  // Read-only enforcement lives in disallowedTools, not permissionMode —
  // bypassPermissions still lets the reviewer run Bash (e.g. tests) inside
  // the worktree without a TTY to approve it, but it can never Edit/Write.
  const reviewerDisallowedTools = ["Edit", "Write", "NotebookEdit"];
  // A sub-agent spawned by the reviewer inherits the same restriction — the
  // reviewer's read-only guarantee shouldn't be escapable by delegating the
  // edit to a sub-agent.
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: card.id,
    worktreeId: worktree.id,
    cwd: worktree.fsPath,
    depth: 1,
    disallowedTools: reviewerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: worktree.fsPath,
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: reviewerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  const verdictMatch = result.resultText.match(/VERDICT:\s*(PASS|FAIL)/i);
  const hasUnsatisfiedCriterion = /CRITERION:.*->\s*NOT SATISFIED/i.test(result.resultText);
  // Fail closed: no parseable verdict, a CLI error, or any criterion marked
  // NOT SATISFIED all count as "fail" so a broken review run — or a reviewer
  // that flags a gap but still writes PASS — can't wave a card through to the
  // gate pipeline.
  const verdict: "pass" | "fail" =
    !result.isError && !hasUnsatisfiedCriterion && verdictMatch?.[1]?.toUpperCase() === "PASS" ? "pass" : "fail";

  await db
    .update(agentRuns)
    .set({ status: result.isError ? "failed" : "succeeded", verdict, logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, run.id));

  return { agentRunId: run.id, isError: result.isError, resultText: result.resultText, costUsd: result.totalCostUsd, logsRef, verdict };
}

// Tags the design spec doc runDesignerSpecAgent creates, distinct from a
// human- or planner-authored spec doc that happens to also be linkType=spec
// — used by hasDesignerSpecDoc to tell whether the designer has already run
// for this card, so a card that re-enters in_progress (e.g. after a
// QUESTION: pause) doesn't get a duplicate spec doc / doc.slug collision.
const DESIGN_SPEC_DOC_TAG = "design-spec";

export async function hasDesignerSpecDoc(cardId: string): Promise<boolean> {
  const linkedRows = await db
    .select()
    .from(cardDocLinks)
    .innerJoin(docsTable, eq(cardDocLinks.docId, docsTable.id))
    .where(and(eq(cardDocLinks.cardId, cardId), eq(cardDocLinks.linkType, "spec")));

  return linkedRows.some((row) => row.docs.tags.includes(DESIGN_SPEC_DOC_TAG));
}

function extractFencedMarkdown(text: string): string | null {
  const match = text.match(/```markdown\s*\n([\s\S]*?)```/);
  return match ? match[1]!.trim() : null;
}

// Runs BEFORE the implementer, when a qualifying (UI/UX-touching) card enters
// in_progress. Read-only like the reviewer, but also disallows Bash — it
// only needs to read the existing codebase to recommend component/token
// reuse, never to run anything. Its output is persisted as a wiki doc and
// spec-linked to the card, so the implementer's next dispatch auto-loads it
// via loadLinkedSpecDocs — no separate prompt-injection path needed.
export async function runDesignerSpecAgent(card: Card): Promise<AgentRunResult> {
  const worktree = await getActiveWorktree(card.id);
  if (!worktree) throw new Error(`no active worktree for card ${card.id}`);

  const roleId = await getRoleId("designer");
  const prompt = buildDesignerSpecPrompt(card);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: card.id, agentRoleId: roleId, worktreeId: worktree.id, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  const designerDisallowedTools = ["Edit", "Write", "NotebookEdit", "Bash"];
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: card.id,
    worktreeId: worktree.id,
    cwd: worktree.fsPath,
    depth: 1,
    disallowedTools: designerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: worktree.fsPath,
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: designerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  await db
    .update(agentRuns)
    .set({ status: result.isError ? "failed" : "succeeded", logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, run.id));

  if (!result.isError) {
    const specBody = extractFencedMarkdown(result.resultText) ?? result.resultText.trim();
    const specDoc = await createDoc({
      slug: `design-spec-${card.id}`,
      title: `Design Spec: ${card.title}`,
      docType: "wiki",
      summary: `Design spec for "${card.title}"`.slice(0, 200),
      content: specBody,
      tags: [DESIGN_SPEC_DOC_TAG],
      message: `designer spec for card ${card.id}`,
    });
    await db.insert(cardDocLinks).values({ cardId: card.id, docId: specDoc.id, linkType: "spec" });
  }

  return {
    agentRunId: run.id,
    isError: result.isError,
    resultText: result.resultText,
    costUsd: result.totalCostUsd,
    logsRef,
  };
}

// Runs alongside the reviewer at in_review, against the same diff. Read-only
// like the reviewer, plus Bash disallowed — this is static analysis of the
// diff, it never needs to execute anything. Returns the same VERDICT:
// PASS/FAIL convention as the reviewer, recorded as the design_review gate.
export async function runDesignerReviewAgent(card: Card): Promise<ReviewerRunResult> {
  const worktree = await getActiveWorktree(card.id);
  if (!worktree) throw new Error(`no active worktree for card ${card.id}`);

  const roleId = await getRoleId("designer");
  const diff = await getRepoDiff(worktree.fsPath, worktree.baseCommitSha);
  const specDocs = [...(await loadProjectBrief(card)), ...(await loadLinkedSpecDocs(card))];
  const prompt = buildDesignerReviewPrompt(card, diff, specDocs);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: card.id, agentRoleId: roleId, worktreeId: worktree.id, status: "verifying", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  const designerDisallowedTools = ["Edit", "Write", "NotebookEdit", "Bash"];
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: card.id,
    worktreeId: worktree.id,
    cwd: worktree.fsPath,
    depth: 1,
    disallowedTools: designerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: worktree.fsPath,
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: designerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  const verdictMatch = result.resultText.match(/VERDICT:\s*(PASS|FAIL)/i);
  const verdict: "pass" | "fail" = !result.isError && verdictMatch?.[1]?.toUpperCase() === "PASS" ? "pass" : "fail";

  await db
    .update(agentRuns)
    .set({ status: result.isError ? "failed" : "succeeded", verdict, logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, run.id));

  return { agentRunId: run.id, isError: result.isError, resultText: result.resultText, costUsd: result.totalCostUsd, logsRef, verdict };
}

// Called from deploy-engine's docker-compose provider when rebasing a card's
// branch onto base (before merging into the shared trunk checkout) hits a
// conflict. Runs inside the card's own worktree with full tool access — same
// isolation boundary as the implementer, just a narrower job: resolve the
// conflict markers, run tests, `git rebase --continue`.
export async function runIntegratorAgent(
  card: Card,
  worktree: { id: string; fsPath: string },
  conflictedFiles: string[],
): Promise<AgentRunResult> {
  const roleId = await getRoleId("integrator");
  const prompt = buildIntegratorPrompt(card, conflictedFiles);

  const [run] = await db
    .insert(agentRuns)
    .values({ cardId: card.id, agentRoleId: roleId, worktreeId: worktree.id, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: card.id,
    worktreeId: worktree.id,
    cwd: worktree.fsPath,
    depth: 1,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: worktree.fsPath,
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);
  const question = !result.isError ? extractQuestion(result.resultText) : null;

  await db
    .update(agentRuns)
    .set({ status: result.isError ? "failed" : "succeeded", logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, run.id));

  return {
    agentRunId: run.id,
    isError: result.isError,
    resultText: result.resultText,
    costUsd: result.totalCostUsd,
    logsRef,
    question: question ?? undefined,
  };
}

export interface ProjectAnalyzerRunHandle {
  agentRunId: string;
  result: Promise<AgentRunResult>;
}

const analyzerDisallowedTools = ["Edit", "Write", "NotebookEdit"];

// Kicked off once, fire-and-forget, right after POST /projects registers a
// project (local path or fresh clone) — see apps/api/src/routes/projects.ts.
// Split start/execute the same way the planner is: the caller gets an
// agentRunId back immediately (so the UI can attach a live AgentSessionPanel
// to it) without blocking the HTTP response on however long the CLI takes to
// explore the repo. Runs directly against project.repoPath, not a worktree —
// there's no card or branch here, just the target repo itself — so
// analyzerDisallowedTools is what keeps this read-only; there is no
// isolation layer to fall back on if that were wrong.
export async function startProjectAnalyzerAgent(project: {
  id: string;
  name: string;
  repoPath: string;
}): Promise<ProjectAnalyzerRunHandle> {
  const roleId = await getRoleId("analyzer");
  const prompt = buildProjectAnalyzerPrompt({ name: project.name, repoPath: project.repoPath });

  const [run] = await db
    .insert(agentRuns)
    .values({ agentRoleId: roleId, projectId: project.id, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  return { agentRunId: run.id, result: executeProjectAnalyzerAgent(project, run.id, prompt) };
}

// Despite the prompt's "output nothing but the brief" instruction, a CLI
// turn can still open with a stray aside from whatever it explored right
// before writing the brief (observed once in practice: a one-line comment
// about a lint script, unrelated to the brief itself, ahead of "# Purpose").
// Cheaper and more robust to trim it here than to keep tightening the
// prompt against a model behavior that can vary run to run.
function stripPreamble(text: string): string {
  const headingIndex = text.indexOf("# Purpose");
  return headingIndex > 0 ? text.slice(headingIndex) : text;
}

async function executeProjectAnalyzerAgent(
  project: { id: string; name: string; repoPath: string },
  runId: string,
  prompt: string,
): Promise<AgentRunResult> {
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: runId,
    cardId: null,
    worktreeId: null,
    cwd: project.repoPath,
    depth: 1,
    disallowedTools: analyzerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: project.repoPath,
    agentRunId: runId,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: analyzerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(runId, result.raw);

  if (result.isError || !result.resultText.trim()) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, runId));
    await db.update(projects).set({ briefStatus: "failed" }).where(eq(projects.id, project.id));
    return { agentRunId: runId, isError: true, resultText: result.resultText, costUsd: result.totalCostUsd, logsRef };
  }

  const slug = `project-brief-${project.id}`;
  const doc = await createDoc({
    slug,
    title: `${project.name} — project brief`,
    docType: "brief",
    content: stripPreamble(result.resultText),
    summary: `Auto-generated overview of ${project.name}'s stack, architecture, and conventions.`,
    tags: ["project-brief"],
    message: "analyzer agent: generate project brief",
  });

  await db
    .update(agentRuns)
    .set({ status: "succeeded", logsRef, finishedAt: new Date() })
    .where(eq(agentRuns.id, runId));
  await db.update(projects).set({ briefDocId: doc.id, briefStatus: "ready" }).where(eq(projects.id, project.id));

  return { agentRunId: runId, isError: false, resultText: result.resultText, costUsd: result.totalCostUsd, logsRef };
}

// Convenience wrapper for callers (API route) that just want to fire this off
// without holding the agentRunId — errors are swallowed into briefStatus
// "failed" (already persisted by executeProjectAnalyzerAgent), not thrown,
// since this always runs detached from an HTTP response.
export async function runProjectAnalyzerAgent(project: { id: string; name: string; repoPath: string }): Promise<void> {
  try {
    await startProjectAnalyzerAgent(project).then((h) => h.result);
  } catch (err) {
    console.error(`[analyzer] project ${project.id} failed:`, err);
    await db
      .update(projects)
      .set({ briefStatus: "failed" })
      .where(eq(projects.id, project.id))
      .catch(() => {});
  }
}
