"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, cn, Textarea } from "@loopeng/ui";
import { api, ApiError } from "../../lib/api";
import { AgentSessionPanel } from "../card/[cardId]/AgentSessionPanel";
import { useBoard } from "../providers/BoardProvider";

const SESSION_LIST_POLL_MS = 4000;
const STATUS_POLL_MS = 2000;

function statusMeta(status: string): { label: string; tone: string } {
  switch (status) {
    case "running":
      return { label: "In conversation", tone: "bg-secondary text-muted-foreground" };
    case "awaiting_approval":
      return { label: "Awaiting approval", tone: "bg-warning/15 text-warning" };
    case "succeeded":
      return { label: "Approved", tone: "bg-success/15 text-success" };
    case "failed":
      return { label: "Failed", tone: "bg-destructive/15 text-destructive" };
    default:
      return { label: status, tone: "bg-secondary text-muted-foreground" };
  }
}

// A dedicated page instead of a modal, on purpose: a planning conversation
// can run long (multiple clarifying rounds), and nothing about it should be
// lost just because you navigated away or the api restarted mid-conversation
// -- both the session list and every session's status are re-derived from
// the database on every load (see GET /boards/:id/intake[/...]), not held in
// a component that resets when closed.
function PlanPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { boardId } = useBoard();
  const queryClient = useQueryClient();

  const [requestText, setRequestText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedId = searchParams.get("session");

  const sessionsQuery = useQuery({
    queryKey: ["intake-sessions", boardId],
    queryFn: () => api.listIntakeSessions(boardId!),
    enabled: !!boardId,
    refetchInterval: SESSION_LIST_POLL_MS,
  });

  const statusQuery = useQuery({
    queryKey: ["intake-status", boardId, selectedId],
    queryFn: () => api.getIntakeStatus(boardId!, selectedId!),
    enabled: !!boardId && !!selectedId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? STATUS_POLL_MS : false),
  });

  const approveMutation = useMutation({
    mutationFn: () => api.approveIntake(boardId!, selectedId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intake-status", boardId, selectedId] });
      queryClient.invalidateQueries({ queryKey: ["intake-sessions", boardId] });
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    },
  });

  async function handleSubmit() {
    if (!requestText.trim() || !boardId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { agentRunId } = await api.intake(boardId, requestText.trim());
      setRequestText("");
      await queryClient.invalidateQueries({ queryKey: ["intake-sessions", boardId] });
      router.push(`/plan?session=${agentRunId}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const sessions = sessionsQuery.data ?? [];
  const status = statusQuery.data;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r border-border">
        <div className="shrink-0 border-b border-border p-4">
          <h2 className="mb-2 text-sm font-bold text-foreground">New request</h2>
          <Textarea
            rows={4}
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            placeholder="Describe what you need — the planner will ask if anything's unclear"
            className="w-full text-sm"
          />
          {submitError && <p className="mt-2 text-xs text-destructive">{submitError}</p>}
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={handleSubmit}
            disabled={!requestText.trim() || submitting || !boardId}
          >
            {submitting ? "Starting…" : "Start conversation"}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No planning sessions yet on this board.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((s) => {
                const meta = statusMeta(s.status);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/plan?session=${s.id}`)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-xs transition-colors",
                        selectedId === s.id ? "bg-accent" : "hover:bg-accent/50",
                      )}
                    >
                      <span className={cn("w-fit rounded-full px-2 py-0.5 font-medium", meta.tone)}>{meta.label}</span>
                      <span className="text-muted-foreground">{s.startedAt ? new Date(s.startedAt).toLocaleString() : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Start a new request, or pick a past session on the left.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <AgentSessionPanel
              agentRunId={selectedId}
              roleName="planner"
              live={status?.status === "running"}
              heightClassName="min-h-[280px] flex-1"
            />

            {status?.status === "awaiting_approval" && (
              <div className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 p-4">
                <h3 className="text-sm font-bold text-foreground">Proposed plan: {status.proposal.specTitle}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Will create {status.proposal.cardCount} card{status.proposal.cardCount === 1 ? "" : "s"} in backlog —
                  nothing exists on the board yet.
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {status.proposal.cards.map((c, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm"
                    >
                      <span className="flex-1 truncate">{c.title}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {c.cardType}
                      </Badge>
                      <Badge
                        variant={c.riskTier === "high" ? "destructive" : c.riskTier === "medium" ? "warning" : "success"}
                        className="text-[10px]"
                      >
                        {c.riskTier}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <Button className="mt-3" onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending}>
                  {approveMutation.isPending
                    ? "Creating…"
                    : `Approve → create ${status.proposal.cardCount} card${status.proposal.cardCount === 1 ? "" : "s"}`}
                </Button>
                {approveMutation.isError && (
                  <p className="mt-2 text-xs text-destructive">
                    {approveMutation.error instanceof ApiError
                      ? approveMutation.error.message
                      : (approveMutation.error as Error).message}
                  </p>
                )}
              </div>
            )}

            {status?.status === "succeeded" && (
              <div className="shrink-0 rounded-lg border border-success/30 bg-success/5 p-4">
                <p className="text-sm font-semibold text-success">
                  ✓ Created {status.result.cardIds.length + 1} card{status.result.cardIds.length === 0 ? "" : "s"} in backlog.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    router.push(`/board?highlight=${[status.result.epicCardId, ...status.result.cardIds].join(",")}`)
                  }
                >
                  View on board
                </Button>
              </div>
            )}

            {status?.status === "failed" && (
              <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-semibold text-destructive">Failed</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{status.error}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlanPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
      <PlanPageInner />
    </Suspense>
  );
}
