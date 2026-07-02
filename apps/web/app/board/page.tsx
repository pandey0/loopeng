"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Column, Button } from "@loopeng/ui";
import type { CardState, CardWithStatus } from "@loopeng/shared";
import { api } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";
import { ActivityFeed } from "./ActivityFeed";

const HIGHLIGHT_DURATION_MS = 4000;

// Phase 3 orchestrator now runs the full gate pipeline at gate_checks and
// routes by risk_tier: high stops at awaiting_approval for a human click,
// low/medium auto-advance to deploying. deploying stays a dead-end column
// until Phase 4 (deploy execution) lands.
const PHASE_3_COLUMNS: { state: CardState; title: string }[] = [
  { state: "backlog", title: "Backlog" },
  { state: "ready", title: "Ready" },
  { state: "in_progress", title: "In Progress" },
  { state: "in_review", title: "In Review" },
  { state: "gate_checks", title: "Gate Checks" },
  { state: "awaiting_approval", title: "Awaiting Approval" },
  { state: "deploying", title: "Deploying" },
  { state: "blocked", title: "Blocked" },
  { state: "done", title: "Done" },
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
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());

  const cardsQuery = useQuery({
    queryKey: ["cards", boardId],
    queryFn: () => api.listCards(boardId!),
    enabled: !!boardId,
  });

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

  const cards = cardsQuery.data ?? [];
  const byState = (state: CardState) => cards.filter((c) => c.state === state);

  async function handleDrop(cardId: string, toState: CardState) {
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

  return (
    <div>
      {boardId && (
        <div className="mb-4 flex items-center justify-end">
          <Link href={`/board/${boardId}/graph`} className="text-sm text-primary hover:underline">
            Dependency graph →
          </Link>
        </div>
      )}
      <div className="flex gap-3">
        <div className="flex flex-1 gap-3 overflow-x-auto">
          {PHASE_3_COLUMNS.map(({ state, title }) => (
            <Column
              key={state}
              state={state}
              title={title}
              cards={byState(state)}
              onDropCard={handleDrop}
              onCardClick={(card) => router.push(`/card/${card.id}`)}
              draggingCardState={draggingCard?.state}
              onCardDragStart={setDraggingCard}
              onCardDragEnd={() => setDraggingCard(null)}
              highlightedCardIds={highlightIds}
              cardRef={(cardId, el) => {
                if (el) cardEls.current.set(cardId, el);
                else cardEls.current.delete(cardId);
              }}
              renderCardFooter={
                state === "awaiting_approval"
                  ? (card) => (
                      <Button size="sm" onClick={() => handleApprove(card.id)} className="-mt-1 mb-2 h-auto px-2 py-1 text-[11px]">
                        Approve → Deploy
                      </Button>
                    )
                  : state === "blocked"
                    ? (card) => (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRetry(card.id)}
                          className="-mt-1 mb-2 h-auto px-2 py-1 text-[11px]"
                        >
                          Retry
                        </Button>
                      )
                    : undefined
              }
            />
          ))}
        </div>
        <ActivityFeed boardId={boardId} />
      </div>
    </div>
  );
}
