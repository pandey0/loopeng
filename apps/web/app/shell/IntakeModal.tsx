"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog, Textarea } from "@loopeng/ui";
import type { Card } from "@loopeng/shared";
import { api, ApiError, type IntakeResult } from "../../lib/api";

export interface IntakeModalProps {
  boardId: string;
  open: boolean;
  onClose: () => void;
}

type Phase = "form" | "running" | "error" | "success";

export function IntakeModal({ boardId, open, onClose }: IntakeModalProps) {
  const router = useRouter();
  const [requestText, setRequestText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [previewCards, setPreviewCards] = useState<Card[]>([]);

  function reset() {
    setRequestText("");
    setPhase("form");
    setError(null);
    setResult(null);
    setPreviewCards([]);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!requestText.trim()) return;
    setPhase("running");
    setError(null);
    try {
      const intakeResult = await api.intake(boardId, requestText.trim());
      const allIds = new Set([intakeResult.epicCardId, ...intakeResult.cardIds]);
      const boardCards = await api.listCards(boardId);
      setPreviewCards(boardCards.filter((c) => allIds.has(c.id)));
      setResult(intakeResult);
      setPhase("success");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      setPhase("error");
    }
  }

  function handleViewOnBoard() {
    if (!result) return;
    const ids = [result.epicCardId, ...result.cardIds];
    router.push(`/board?highlight=${ids.join(",")}`);
    handleClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="New request"
      description="Describe what you need. A planner agent will draft a spec and decompose it into cards on this board."
    >
      {phase === "form" || phase === "error" ? (
        <div>
          <Textarea
            autoFocus
            rows={6}
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            placeholder="e.g. Add rate limiting to the public API so a single client can't exhaust our request budget"
            className="w-full"
          />
          {phase === "error" && error && (
            <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!requestText.trim()}>
              {phase === "error" ? "Retry" : "Submit"}
            </Button>
          </div>
        </div>
      ) : phase === "running" ? (
        <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Planner agent is decomposing this request into cards — this can take tens of seconds.
        </div>
      ) : (
        <div>
          <p className="mb-3 text-sm text-muted-foreground">
            Created {previewCards.length} card{previewCards.length === 1 ? "" : "s"} in backlog:
          </p>
          <ul className="mb-4 max-h-64 list-none space-y-1.5 overflow-y-auto p-0">
            {previewCards.map((card) => (
              <li key={card.id} className="flex items-center gap-2 rounded-md border bg-muted px-2.5 py-1.5 text-sm">
                <span className="flex-1 truncate">{card.title}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {card.cardType}
                </Badge>
                <Badge
                  variant={card.riskTier === "high" ? "destructive" : card.riskTier === "medium" ? "warning" : "success"}
                  className="text-[10px]"
                >
                  {card.riskTier}
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
            <Button onClick={handleViewOnBoard}>View on board</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
