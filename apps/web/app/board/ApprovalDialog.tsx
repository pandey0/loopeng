"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Dialog, StatusBadge } from "@loopeng/ui";
import type { GateResultStatus } from "@loopeng/shared";
import { api, type CardDetailAgentRun } from "../../lib/api";
import { AgentSessionPanel } from "../card/[cardId]/AgentSessionPanel";

export interface ApprovalDialogProps {
  cardId: string | null;
  onClose: () => void;
  onApprove: (cardId: string) => Promise<void>;
}

// A reviewer verdict is only meaningful alongside the actual work it judged —
// this dialog exists so "Approve -> Deploy" is never just a bare button: it
// shows the real diff, the reviewer's own reasoning (replayed from its
// transcript, not just a pass/fail badge), and gate results before letting a
// human commit to deploying.
export function ApprovalDialog({ cardId, onClose, onApprove }: ApprovalDialogProps) {
  const [approving, setApproving] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["card-detail", cardId],
    queryFn: () => api.getCardDetail(cardId!),
    enabled: !!cardId,
  });
  const diffQuery = useQuery({
    queryKey: ["card-diff", cardId],
    queryFn: () => api.getCardDiff(cardId!),
    enabled: !!cardId,
  });

  const latestReviewerRun = useMemo<CardDetailAgentRun | null>(() => {
    const runs = detailQuery.data?.agentRuns.filter((r) => r.roleName === "reviewer") ?? [];
    if (runs.length === 0) return null;
    return runs.reduce((latest, r) => ((r.finishedAt ?? r.startedAt ?? "") > (latest.finishedAt ?? latest.startedAt ?? "") ? r : latest));
  }, [detailQuery.data]);

  async function handleApprove() {
    if (!cardId) return;
    setApproving(true);
    try {
      await onApprove(cardId);
      onClose();
    } finally {
      setApproving(false);
    }
  }

  const card = detailQuery.data;

  return (
    <Dialog
      open={!!cardId}
      onClose={onClose}
      title={card ? `Approve: ${card.title}` : "Approve"}
      description="Review what's actually being deployed before approving."
      className="max-w-3xl"
    >
      {!card ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={card.riskTier === "high" ? "destructive" : card.riskTier === "medium" ? "warning" : "success"}>
              risk: {card.riskTier}
            </Badge>
            {card.touchesArchitecture && <Badge variant="secondary">touches architecture</Badge>}
            <span className="text-muted-foreground">P{card.priority}</span>
          </div>

          <div>
            <h3 className="mb-1.5 text-sm font-semibold">Reviewer verdict</h3>
            {latestReviewerRun ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant={latestReviewerRun.verdict === "pass" ? "success" : "destructive"}>
                    {latestReviewerRun.verdict ?? latestReviewerRun.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    {latestReviewerRun.finishedAt ? new Date(latestReviewerRun.finishedAt).toLocaleString() : "in progress"}
                  </span>
                </div>
                <div className="rounded-md border">
                  <AgentSessionPanel agentRunId={latestReviewerRun.id} roleName="reviewer" live={latestReviewerRun.live} />
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No reviewer run found for this card.</p>
            )}
          </div>

          <div>
            <h3 className="mb-1.5 text-sm font-semibold">Gate results</h3>
            {card.gateResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No gate results yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {card.gateResults.map((gate) => (
                  <li key={gate.id} className="flex items-center gap-2">
                    <StatusBadge status={gate.status as GateResultStatus} />
                    <span>{gate.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setDiffOpen((v) => !v)}
              className="mb-1.5 text-sm font-semibold text-primary hover:underline"
            >
              {diffOpen ? "Hide diff" : "Show diff"}
            </button>
            {diffOpen && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2.5 text-[11px]">
                {diffQuery.isLoading ? "Loading diff…" : diffQuery.data?.diff || "No diff available (worktree may already be torn down)."}
              </pre>
            )}
          </div>

          {card.linkedDocs.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-sm font-semibold">Linked docs</h3>
              <ul className="flex flex-wrap gap-1.5">
                {card.linkedDocs.map((link) => (
                  <li key={link.docId}>
                    <Badge variant="outline">{link.title}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" onClick={onClose} disabled={approving}>
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={approving}>
              {approving ? "Approving…" : "Approve → Deploy"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
