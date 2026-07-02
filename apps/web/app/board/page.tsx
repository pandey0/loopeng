"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Column, Button } from "@loopeng/ui";
import type { Card, CardState } from "@loopeng/shared";
import { api } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";
import { ActivityFeed } from "./ActivityFeed";

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
  const router = useRouter();
  const queryClient = useQueryClient();
  const { boardId, boards, boardsLoading } = useBoard();
  const [draggingCard, setDraggingCard] = useState<Card | null>(null);

  const cardsQuery = useQuery({
    queryKey: ["cards", boardId],
    queryFn: () => api.listCards(boardId!),
    enabled: !!boardId,
  });

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
              onCardClick={(card: Card) => router.push(`/card/${card.id}`)}
              draggingCardState={draggingCard?.state}
              onCardDragStart={setDraggingCard}
              onCardDragEnd={() => setDraggingCard(null)}
              renderCardFooter={
                state === "awaiting_approval"
                  ? (card) => (
                      <Button size="sm" onClick={() => handleApprove(card.id)} className="-mt-1 mb-2 h-auto px-2 py-1 text-[11px]">
                        Approve → Deploy
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
