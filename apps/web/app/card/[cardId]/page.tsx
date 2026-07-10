"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  cn,
  Dialog,
  getStatusMeta,
  Input,
  LiveIndicator,
  StatusBadge,
  Tabs,
  buildAgentRunTree,
  flattenAgentRunTree,
} from "@loopeng/ui";
import type { GateResultStatus, RiskTier } from "@loopeng/shared";
import { api, type CardDetailAgentRun } from "../../../lib/api";
import { AgentSessionPanel } from "./AgentSessionPanel";

// A gate's `detail` blob (failure reasons, stderr tails, criteria breakdowns,
// etc.) is only worth surfacing eagerly when the gate didn't pass — mirror
// the same destructive-tone check StatusBadge uses so any current or future
// failure-like status (not just the literal "failed") auto-expands.
function isFailureLikeStatus(status: string): boolean {
  return getStatusMeta(status as GateResultStatus).tone === "destructive";
}

// Mirrors CardTile's own priority/risk tone logic (not exported from
// @loopeng/ui) so the card detail header reads consistently with the board.
function priorityBadgeClass(priority: number): string {
  if (priority <= 1) return "bg-destructive/15 text-destructive";
  if (priority === 2) return "bg-warning/15 text-warning";
  return "bg-secondary text-muted-foreground";
}

const RISK_DOT_CLASS: Record<RiskTier, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};

// Section label style used for every "Acceptance criteria" / "Dependencies" /
// "Questions" / "Timeline" / etc. heading on this page: small uppercase
// muted label, not a large heading.
const SECTION_LABEL_CLASS = "mb-2.5 text-[12.5px] font-bold uppercase tracking-[0.04em] text-muted-foreground";

// AgentRunStatus (queued/running/succeeded/failed/verifying) isn't part of
// StatusKey, so it can't go through getStatusMeta/StatusBadge — this is a
// small local tone map for the same "colored pill" treatment, same spirit as
// CardTile's local priorityBadgeClass.
function agentRunStatusVariant(status: string): "success" | "destructive" | "default" | "secondary" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "destructive";
  if (status === "running" || status === "verifying") return "default";
  return "secondary";
}

interface TimelineRow {
  at: Date;
  kind: "agent_run" | "gate_result" | "event";
  label: string;
  detail: string;
}

export default function CardDetailPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = use(params);
  const queryClient = useQueryClient();
  const detailQuery = useQuery({ queryKey: ["card-detail", cardId], queryFn: () => api.getCardDetail(cardId) });

  const [criteria, setCriteria] = useState<string[]>([]);
  const [newCriterion, setNewCriterion] = useState("");
  const [saving, setSaving] = useState(false);
  const [sessionRun, setSessionRun] = useState<CardDetailAgentRun | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    if (detailQuery.data) setCriteria(detailQuery.data.acceptanceCriteria);
  }, [detailQuery.data]);

  const timeline = useMemo<TimelineRow[]>(() => {
    if (!detailQuery.data) return [];
    const card = detailQuery.data;
    const rows: TimelineRow[] = [];

    for (const run of card.agentRuns) {
      const at = run.startedAt ?? run.finishedAt;
      if (!at) continue;
      rows.push({
        at: new Date(at),
        kind: "agent_run",
        label: run.roleName ?? "agent run",
        detail: `${run.status}${run.verdict ? ` — verdict: ${run.verdict}` : ""}`,
      });
    }
    for (const gate of card.gateResults) {
      rows.push({
        at: new Date(gate.createdAt),
        kind: "gate_result",
        label: gate.name,
        detail: gate.status,
      });
    }
    for (const event of card.events) {
      const { from, to } = event.payload as { from?: string; to?: string };
      rows.push({
        at: new Date(event.createdAt),
        kind: "event",
        label: event.eventType,
        detail: to ? `${String(from ?? "?")} → ${String(to)}` : "",
      });
    }

    return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  }, [detailQuery.data]);

  // Delegation tree: sub-agent runs (non-null parentAgentRunId) nest under
  // the run that spawned them, in startedAt order within each level.
  const agentRunRows = useMemo(
    () => flattenAgentRunTree(buildAgentRunTree(detailQuery.data?.agentRuns ?? [])),
    [detailQuery.data],
  );

  if (detailQuery.isLoading) return <p>Loading...</p>;
  if (!detailQuery.data) return <p>Not found.</p>;

  const card = detailQuery.data;

  async function saveCriteria(next: string[]) {
    setCriteria(next);
    setSaving(true);
    try {
      await api.updateCard(cardId, { acceptanceCriteria: next });
      queryClient.invalidateQueries({ queryKey: ["card-detail", cardId] });
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function addCriterion() {
    const value = newCriterion.trim();
    if (!value) return;
    saveCriteria([...criteria, value]);
    setNewCriterion("");
  }

  function removeCriterion(index: number) {
    saveCriteria(criteria.filter((_, i) => i !== index));
  }

  async function submitAnswer(questionId: string) {
    const answer = (answerDrafts[questionId] ?? "").trim();
    if (!answer) return;
    setAnswering(questionId);
    try {
      await api.answerCardQuestion(cardId, questionId, answer);
      queryClient.invalidateQueries({ queryKey: ["card-detail", cardId] });
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setAnswering(null);
    }
  }

  const overview = (
    <div>
      {card.description && <p className="mb-4 text-[14px] leading-[1.65] text-foreground">{card.description}</p>}

      {card.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {card.tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="rounded-full border border-border bg-card px-[9px] py-[3px] font-mono text-[11px] font-normal text-muted-foreground"
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <h3 className={SECTION_LABEL_CLASS}>Acceptance criteria</h3>
      <ul className="list-none space-y-1.5 p-0">
        {criteria.map((criterion, index) => (
          <li
            key={index}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-[9px] text-sm"
          >
            <span className="text-success">✓</span>
            <span className="flex-1">{criterion}</span>
            <button
              type="button"
              disabled={saving}
              onClick={() => removeCriterion(index)}
              aria-label="Remove acceptance criterion"
              className="text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="mb-6 mt-2 flex gap-2">
        <Input
          value={newCriterion}
          onChange={(e) => setNewCriterion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCriterion()}
          placeholder="Add acceptance criterion"
          className="flex-1 rounded-lg"
        />
        <Button disabled={saving} onClick={addCriterion} className="rounded-lg bg-secondary font-semibold text-secondary-foreground hover:bg-secondary/80">
          Add
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h3 className={SECTION_LABEL_CLASS}>Dependencies</h3>
          {card.dependsOn.length === 0 ? (
            <p className="text-xs text-muted-foreground">No dependencies.</p>
          ) : (
            <ul className="list-none space-y-1.5 p-0">
              {card.dependsOn.map((dep) => (
                <li
                  key={dep.dependsOnCardId}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-[9px]"
                >
                  <Link href={`/card/${dep.dependsOnCardId}`} className="flex-1 truncate font-mono text-[13px] text-primary hover:underline">
                    {dep.dependsOnCardId}
                  </Link>
                  <Badge
                    variant={dep.dependencyType === "blocks" ? "destructive" : "secondary"}
                    className="shrink-0 rounded px-[7px] py-0.5 font-mono text-[10px]"
                  >
                    {dep.dependencyType}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className={SECTION_LABEL_CLASS}>Dependents</h3>
          {card.dependents.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing depends on this card.</p>
          ) : (
            <ul className="list-none space-y-1.5 p-0">
              {card.dependents.map((dep) => (
                <li
                  key={dep.cardId}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-[9px]"
                >
                  <Link href={`/card/${dep.cardId}`} className="flex-1 truncate font-mono text-[13px] text-primary hover:underline">
                    {dep.cardId}
                  </Link>
                  <Badge
                    variant={dep.dependencyType === "blocks" ? "destructive" : "secondary"}
                    className="shrink-0 rounded px-[7px] py-0.5 font-mono text-[10px]"
                  >
                    {dep.dependencyType}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h3 className={SECTION_LABEL_CLASS}>Linked docs</h3>
      {card.linkedDocs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No linked docs.</p>
      ) : (
        <ul className="mb-4 flex flex-wrap gap-1.5">
          {card.linkedDocs.map((link) => (
            <li key={link.docId}>
              <Link
                href={`/docs/${link.slug}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-[6px] font-mono text-[11.5px] text-secondary-foreground hover:text-primary"
              >
                <span className="uppercase text-muted-foreground">{link.docType}</span>
                {link.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const activity = (
    <div>
      <h3 className={SECTION_LABEL_CLASS}>Questions</h3>
      {card.questions.length === 0 ? (
        <p className="mb-6 text-xs text-muted-foreground">No questions raised yet.</p>
      ) : (
        <ul className="mb-6 list-none space-y-3 p-0 text-sm">
          {card.questions.map((q) => (
            <li
              key={q.id}
              className={cn(
                "rounded-[10px] border bg-card px-4 py-[14px]",
                q.status === "open" ? "border-warning/40" : "border-border",
              )}
            >
              <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <Badge className="rounded px-[7px] py-0.5 font-mono text-[11px] font-normal bg-primary/10 text-primary" variant="secondary">
                  {q.roleName}
                </Badge>
                <span className="font-mono">{new Date(q.createdAt).toLocaleString()}</span>
                {q.status === "open" && (
                  <Badge variant="warning" className="ml-auto rounded-full px-2 py-0.5 font-mono text-[10.5px] font-bold">
                    needs answer
                  </Badge>
                )}
              </div>
              <p className="mb-2 text-[13.5px] leading-[1.55] text-foreground">{q.question}</p>
              {q.status === "answered" ? (
                <div className="rounded-lg border-l-[3px] border-primary bg-background px-3 py-[10px] text-xs text-muted-foreground">
                  {q.answer}
                  <div className="mt-0.5 font-mono opacity-75">answered by {q.answeredBy ?? "product_owner"}</div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    value={answerDrafts[q.id] ?? ""}
                    onChange={(e) => setAnswerDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && submitAnswer(q.id)}
                    placeholder="Answer this question"
                    className="flex-1 rounded-lg bg-background"
                  />
                  <Button
                    size="sm"
                    disabled={answering === q.id}
                    onClick={() => submitAnswer(q.id)}
                    className="rounded-lg font-bold"
                  >
                    Answer
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className={SECTION_LABEL_CLASS}>Timeline</h3>
      {timeline.length === 0 ? (
        <p className="mb-6 text-xs text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <ul className="mb-6 list-none space-y-[10px] p-0">
          {timeline.map((row, index) => (
            <li key={index} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
                  row.kind === "agent_run" ? "bg-primary" : row.kind === "gate_result" ? "bg-warning" : "bg-muted-foreground",
                )}
              />
              <div className="flex-1">
                <div className="text-[12.5px] text-foreground">
                  <span className="font-medium">{row.label}</span>
                  {row.detail && <span className="text-muted-foreground"> — {row.detail}</span>}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.at.toLocaleString()}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className={SECTION_LABEL_CLASS}>Agent runs</h3>
      {card.agentRuns.length === 0 ? (
        <p className="mb-6 text-xs text-muted-foreground">No agent runs yet.</p>
      ) : (
        <div className="mb-6 overflow-hidden rounded-[10px] border border-border">
          {agentRunRows.map(({ run, depth }, index) => (
            <div
              key={run.id}
              className={cn(
                "flex items-center gap-3 py-[11px] pr-3.5",
                depth > 0 ? "pl-[34px]" : "pl-3.5",
                index < agentRunRows.length - 1 && "border-b border-border",
              )}
            >
              {depth > 0 && (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                  sub
                </span>
              )}
              <span className="w-[110px] shrink-0 truncate font-mono text-[11px] text-primary">{run.roleName ?? "—"}</span>
              <span className="w-[76px] shrink-0">
                <Badge
                  variant={agentRunStatusVariant(run.status)}
                  className="block w-full rounded px-2 py-0.5 text-center font-mono text-[11px]"
                >
                  {run.status}
                </Badge>
              </span>
              <span className="flex-1 truncate text-[11.5px] text-muted-foreground">
                {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                {run.finishedAt ? ` → ${new Date(run.finishedAt).toLocaleString()}` : ""}
                {run.verdict ? ` — verdict: ${run.verdict}` : ""}
              </span>
              {run.live && <LiveIndicator label={null} />}
              <button
                type="button"
                onClick={() => setSessionRun(run)}
                className="shrink-0 font-mono text-[11px] font-medium text-primary hover:underline"
              >
                View session →
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className={SECTION_LABEL_CLASS}>Gate results</h3>
      {card.gateResults.length === 0 ? (
        <p className="text-xs text-muted-foreground">No gate results yet.</p>
      ) : (
        <ul className="list-none space-y-1.5 p-0 text-xs">
          {card.gateResults.map((gate) => {
            const isFailure = isFailureLikeStatus(gate.status);
            const hasDetail = gate.detail && Object.keys(gate.detail).length > 0;
            const row = (
              <div className="flex items-center gap-3 px-3 py-[10px]">
                <span className="flex-1 text-[13px] font-semibold text-foreground">{gate.name}</span>
                <span className="font-mono text-muted-foreground">{new Date(gate.createdAt).toLocaleString()}</span>
                <StatusBadge status={gate.status as GateResultStatus} className="rounded font-mono font-bold" />
              </div>
            );
            return hasDetail ? (
              <li key={gate.id}>
                <details
                  className={cn("rounded-lg border border-border bg-card", isFailure && "border-destructive/50")}
                  open={isFailure}
                >
                  <summary className="cursor-pointer select-none list-none">{row}</summary>
                  <pre className="mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background px-[10px] py-2 font-mono text-[11.5px] text-muted-foreground">
                    {JSON.stringify(gate.detail, null, 2)}
                  </pre>
                </details>
              </li>
            ) : (
              <li key={gate.id} className="rounded-lg border border-border bg-card">
                {row}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
      <div className="w-full max-w-[840px] px-8 pb-20 pt-8">
        <Link
          href="/board"
          className="mb-[18px] inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          ← Back to board
        </Link>
        <h1 className="mb-2.5 text-[22px] font-bold leading-tight">{card.title}</h1>
        <div className="mb-[26px] flex flex-wrap gap-2">
          <span className={cn("rounded-[5px] px-2 py-[3px] font-mono text-[11px] font-bold", priorityBadgeClass(card.priority))}>
            P{card.priority}
          </span>
          <Badge variant="secondary" className="rounded-[5px] px-2 py-[3px] font-mono text-[11px] font-normal">
            {card.cardType}
          </Badge>
          <span className="flex items-center gap-1.5 rounded-[5px] bg-secondary px-2 py-[3px] font-mono text-[11px] text-muted-foreground">
            <span className={cn("h-[6px] w-[6px] shrink-0 rounded-full", RISK_DOT_CLASS[card.riskTier])} />
            {card.riskTier}
          </span>
          {card.touchesArchitecture && (
            <span title="touches architecture" className="rounded-[5px] bg-accent px-2 py-[3px] font-mono text-[11px] font-bold text-accent-foreground">
              ADR
            </span>
          )}
          <StatusBadge status={card.state} className="rounded-[5px] px-2 py-[3px] font-mono text-[11px] font-bold" />
        </div>

        <Tabs
          items={[
            { value: "overview", label: "Overview", content: overview },
            { value: "activity", label: "Activity", content: activity },
          ]}
        />

        {sessionRun && (
          <Dialog
            open
            onClose={() => setSessionRun(null)}
            title={`Agent session — ${sessionRun.roleName ?? "agent"}`}
            description={sessionRun.live ? "Live session: new events stream in and you can send messages." : "Completed run: read-only transcript playback."}
            className="max-w-2xl"
          >
            <AgentSessionPanel agentRunId={sessionRun.id} roleName={sessionRun.roleName} live={sessionRun.live} />
          </Dialog>
        )}
      </div>
    </div>
  );
}
