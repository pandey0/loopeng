import { and, desc, eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { agentRoles, agentRuns, cardDocLinks, cardQuestions, cards, docs as docsTable } from "@loopeng/db";
import { getDoc, listDocs } from "@loopeng/doc-engine";

type Card = typeof cards.$inferSelect;
import { getActiveWorktree, getRepoDiff, resolveRepoRoot } from "@loopeng/worktree-manager";
import { runClaudeCliStreamingOnce } from "./claude-cli.js";
import { parsePlannerOutput, persistDecomposition, PlannerOutputError, type PersistedDecomposition } from "./decomposition.js";
import { writeAgentLog } from "./logs.js";
import {
  buildImplementerPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  type AnsweredQuestionContext,
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

  const results: SkillContext[] = [];
  for (const doc of byId.values()) {
    const full = await getDoc(doc.slug);
    if (full) results.push({ title: full.title, body: full.body });
  }
  return results;
}

async function loadLinkedSpecDocs(card: Card): Promise<SpecDocContext[]> {
  const linkedRows = await db
    .select()
    .from(cardDocLinks)
    .innerJoin(docsTable, eq(cardDocLinks.docId, docsTable.id))
    .where(and(eq(cardDocLinks.cardId, card.id), eq(cardDocLinks.linkType, "spec")));

  const results: SpecDocContext[] = [];
  for (const row of linkedRows) {
    const full = await getDoc(row.docs.slug);
    if (full) results.push({ title: full.title, body: full.body });
  }
  return results;
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
  const specDocs = await loadLinkedSpecDocs(card);
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

// Turns a freeform product-owner request into a boarded epic + child cards.
// Unlike the implementer/reviewer, the planner has no card or worktree yet —
// it runs read-only against the main repo checkout (for codebase context)
// and is never allowed to touch files; its entire output is the two fenced
// blocks parsePlannerOutput expects. On success, the decomposition is
// persisted with every card left in "backlog" — this is an intake tool, not
// an auto-approval bypass, so a human reviews and moves cards to "ready"
// themselves before dispatch.
export async function runPlannerAgent(boardId: string, requestText: string): Promise<PlannerRunResult> {
  const roleId = await getRoleId("planner");
  const existingCards = await db.select({ title: cards.title }).from(cards).where(eq(cards.boardId, boardId));
  const prompt = buildPlannerPrompt(
    requestText,
    existingCards.map((c) => c.title),
  );

  const [run] = await db
    .insert(agentRuns)
    .values({ agentRoleId: roleId, status: "running", startedAt: new Date() })
    .returning();
  if (!run) throw new Error("failed to insert agent_runs row");

  const plannerDisallowedTools = ["Edit", "Write", "NotebookEdit", "Bash"];
  const mcpConfig = buildSubAgentMcpConfig({
    parentAgentRunId: run.id,
    cardId: null,
    worktreeId: null,
    cwd: resolveRepoRoot(),
    depth: 1,
    disallowedTools: plannerDisallowedTools,
  });
  const result = await runClaudeCliStreamingOnce({
    cwd: resolveRepoRoot(),
    agentRunId: run.id,
    prompt,
    permissionMode: "bypassPermissions",
    disallowedTools: plannerDisallowedTools,
    mcpConfig,
  });
  const logsRef = await writeAgentLog(run.id, result.raw);

  if (result.isError) {
    await db.update(agentRuns).set({ status: "failed", logsRef, finishedAt: new Date() }).where(eq(agentRuns.id, run.id));
    throw new PlannerOutputError(`planner agent run failed: ${result.resultText.slice(0, 2000)}`);
  }

  let persisted: PersistedDecomposition;
  try {
    const parsed = parsePlannerOutput(result.resultText);
    persisted = await persistDecomposition(boardId, parsed);
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
  const specDocs = await loadLinkedSpecDocs(card);
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
