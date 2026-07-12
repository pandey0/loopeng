"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Column, Button, isHumanBlocked, getStatusMeta } from "@loopeng/ui";
import type { CardState, CardWithStatus } from "@loopeng/shared";
import { api } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";
import { ActivityFeed } from "./ActivityFeed";
import { ApprovalDialog } from "./ApprovalDialog";
import { StagePipelineBar } from "./StagePipelineBar";
import { AgentSessionDrawer } from "./AgentSessionDrawer";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { useBoardKeyboardShortcuts } from "./useBoardKeyboardShortcuts";

const HIGHLIGHT_DURATION_MS = 4000;
// While anything is actively running, poll listCards so the board tile's
// live snippet (packages/agents session snippet) updates without needing a
// per-tile WebSocket -- cheap compared to that, and the existing SSE event
// stream is for state-transition events, not a token-level firehose.
const ACTIVE_RUN_POLL_MS = 4000;

// Phase 3 orchestrator now runs the full gate pipeline at gate_checks and
// routes by risk_tier: high stops at awaiting_approval for a human click,
// low/medium auto-advance to deploying. deploying stays a dead-end column
// until Phase 4 (deploy execution) lands.
// Titles come from getStatusMeta (the same map the card detail page's
// StatusBadge reads) so a column's label can't drift from what a card's
// detail view shows for that same state.
const PHASE_3_COLUMN_STATES: CardState[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "gate_checks",
  "awaiting_approval",
  "deploying",
  "deploy_failed",
  "blocked",
  "done",
];

export default function BoardPage() {
  return (
    <Suspense fallback={<p>Loading board...</p>}>
      <BoardPageInner />
    </Suspense>
  );
}

function BoardPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { boardId, boards, boardsLoading } = useBoard();
  const [draggingCard, setDraggingCard] = useState<CardWithStatus | null>(null);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [approvalCardId, setApprovalCardId] = useState<string | null>(null);
  const [watchCard, setWatchCard] = useState<CardWithStatus | null>(null);
  const [titleQuery, setTitleQuery] = useState("");
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const cardsQuery = useQuery({
    queryKey: ["cards", boardId],
    queryFn: () => api.listCards(boardId!),
    enabled: !!boardId,
    refetchInterval: (query) => (query.state.data?.some((c) => c.activeAgentRun) ? ACTIVE_RUN_POLL_MS : false),
  });

  const cards = cardsQuery.data ?? [];
  const trimmedQuery = titleQuery.trim().toLowerCase();
  const visibleCards = trimmedQuery ? cards.filter((c) => c.title.toLowerCase().includes(trimmedQuery)) : cards;
  const flatCards = PHASE_3_COLUMN_STATES.flatMap((state) => visibleCards.filter((c) => c.state === state));
  const { focusedCardId, shortcutsOpen, closeShortcuts } = useBoardKeyboardShortcuts(flatCards, setApprovalCardId, () =>
    searchInputRef.current?.focus(),
  );

  useEffect(() => {
    if (!focusedCardId) return;
    cardEls.current.get(focusedCardId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedCardId]);

  // Lands here from the intake modal's "View on board" action
  // (?highlight=id1,id2,...) — pulses the new cards and scrolls the first
  // one into view, then strips the param so it doesn't persist on refresh.
  useEffect(() => {
    const raw = searchParams.get("highlight");
    if (!raw) return;
    const ids = new Set(raw.split(","));
    setHighlightIds(ids);
    router.replace("/board", { scroll: false });

    const firstId = raw.split(",")[0];
    const el = firstId ? cardEls.current.get(firstId) : undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });

    const timer = setTimeout(() => setHighlightIds(new Set()), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  if (boardsLoading) return <p>Loading boards...</p>;
  if (boards.length === 0) {
    return <p>No boards yet. Seed the database first (pnpm db:seed).</p>;
  }

  const byState = (state: CardState) => visibleCards.filter((c) => c.state === state);

  async function handleDrop(cardId: string, toState: CardState) {
    // The state machine itself doesn't know about card_dependencies -- only
    // isReady() (dispatch-time, packages/board-engine/src/dependency-graph.ts)
    // checks unmet "blocks" edges, and only at the moment the orchestrator
    // would pick a ready card up. Moving a card forward manually while it's
    // still blocked is a legal transition that just silently never gets
    // dispatched -- warn here, before the drop, instead of the card sitting
    // there with no explanation (the same class of gap the board's other
    // blockedReason surfacing exists to close).
    const card = cards.find((c) => c.id === cardId);
    if (card && toState !== "backlog" && toState !== "cancelled" && card.dependencyInfo.blockingCards.length > 0) {
      const names = card.dependencyInfo.blockingCards.map((b) => b.title).join(", ");
      const isAre = card.dependencyInfo.blockingCards.length === 1 ? "isn't" : "aren't";
      const proceed = confirm(
        `"${card.title}" depends on ${names}, which ${isAre} done yet.\n\nMoving it to "${toState}" won't get it auto-dispatched until that clears. Move it anyway?`,
      );
      if (!proceed) return;
    }
    try {
      await api.transitionCard(cardId, toState);
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleApprove(cardId: string) {
    try {
      await api.transitionCard(cardId, "deploying");
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleRetry(cardId: string) {
    try {
      await api.transitionCard(cardId, "ready");
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Deploy mechanics (infra pre-check, transient docker error, flaky health
  // check) failed after implementer/reviewer/gates already passed -- retry
  // just the deploy step directly rather than sending the card through the
  // full blocked -> ready recovery cycle, which would re-run everything and
  // force the product owner to re-approve code that never changed.
  async function handleRetryDeploy(cardId: string) {
    try {
      await api.transitionCard(cardId, "deploying");
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StagePipelineBar cards={cards} />
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2">
          <input
            ref={searchInputRef}
            type="text"
            value={titleQuery}
            onChange={(e) => setTitleQuery(e.target.value)}
            placeholder="Search cards by title… (press / to focus)"
            className="w-72 rounded-md border border-border bg-card px-2.5 py-1 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {titleQuery && (
            <button
              type="button"
              onClick={() => setTitleQuery("")}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 p-4">
          {trimmedQuery && visibleCards.length === 0 ? (
            <div className="flex min-w-0 flex-1 items-start justify-center pt-10 text-sm text-muted-foreground">
              No cards match &ldquo;{titleQuery.trim()}&rdquo;.
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto">
              {PHASE_3_COLUMN_STATES.map((state) => (
              <Column
                key={state}
                state={state}
                title={getStatusMeta(state).label}
                cards={byState(state)}
                onDropCard={handleDrop}
                onCardClick={(card) => router.push(`/card/${card.id}`)}
                onCardWatchClick={setWatchCard}
                draggingCardState={draggingCard?.state}
                onCardDragStart={setDraggingCard}
                onCardDragEnd={() => setDraggingCard(null)}
                highlightedCardIds={highlightIds}
                focusedCardId={focusedCardId}
                cardRef={(cardId, el) => {
                  if (el) cardEls.current.set(cardId, el);
                  else cardEls.current.delete(cardId);
                }}
                renderCardFooter={
                  state === "awaiting_approval"
                    ? (card) => (
                        <Button
                          size="sm"
                          onClick={() => setApprovalCardId(card.id)}
                          className="-mt-1 mb-2 h-auto px-2 py-1 text-[11px]"
                        >
                          Review & Approve
                        </Button>
                      )
                    : state === "blocked"
                      ? (card) =>
                          isHumanBlocked(card.blockedReason) ? (
                            <Link
                              href={`/card/${card.id}`}
                              className="-mt-1 mb-2 inline-block rounded-md bg-warning px-2 py-1 text-[11px] font-bold text-warning-foreground"
                            >
                              Answer question →
                            </Link>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRetry(card.id)}
                              className="-mt-1 mb-2 h-auto px-2 py-1 text-[11px]"
                            >
                              Retry
                            </Button>
                          )
                      : state === "deploy_failed"
                        ? (card) => (
                            <div className="-mt-1 mb-2 flex gap-1.5">
                              <Button
                                size="sm"
                                onClick={() => handleRetryDeploy(card.id)}
                                className="h-auto px-2 py-1 text-[11px]"
                              >
                                Retry deploy
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDrop(card.id, "blocked")}
                                className="h-auto px-2 py-1 text-[11px]"
                              >
                                Needs code fix
                              </Button>
                            </div>
                          )
                        : undefined
                }
              />
              ))}
            </div>
          )}
          <ActivityFeed boardId={boardId} />
        </div>
      </div>
      <AgentSessionDrawer card={watchCard} onClose={() => setWatchCard(null)} />
      <ApprovalDialog
        cardId={approvalCardId}
        onClose={() => setApprovalCardId(null)}
        onApprove={(cardId) => handleApprove(cardId)}
      />
      {!watchCard?.activeAgentRun && !approvalCardId && (
        <div className="fixed bottom-4 left-4 z-30 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          press <span className="text-foreground">?</span> for shortcuts
        </div>
      )}
      <ShortcutsHelpDialog open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
