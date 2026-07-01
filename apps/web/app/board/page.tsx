"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Column } from "@loopeng/ui";
import type { Card, CardState } from "@loopeng/shared";
import { api } from "../../lib/api";

// Phase 1 only exercises this subset of the full card state machine —
// gate_checks/awaiting_approval/deploying are reserved for Phase 3/4.
const PHASE_1_COLUMNS: { state: CardState; title: string }[] = [
  { state: "backlog", title: "Backlog" },
  { state: "ready", title: "Ready" },
  { state: "in_progress", title: "In Progress" },
  { state: "in_review", title: "In Review" },
  { state: "blocked", title: "Blocked" },
  { state: "done", title: "Done" },
];

export default function BoardPage() {
  const queryClient = useQueryClient();
  const [boardId, setBoardId] = useState<string | null>(null);

  const boardsQuery = useQuery({ queryKey: ["boards"], queryFn: api.listBoards });

  useEffect(() => {
    if (!boardId && boardsQuery.data && boardsQuery.data.length > 0) {
      setBoardId(boardsQuery.data[0]!.id);
    }
  }, [boardId, boardsQuery.data]);

  const cardsQuery = useQuery({
    queryKey: ["cards", boardId],
    queryFn: () => api.listCards(boardId!),
    enabled: !!boardId,
  });

  if (boardsQuery.isLoading) return <p>Loading boards...</p>;
  if (!boardsQuery.data || boardsQuery.data.length === 0) {
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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <select value={boardId ?? ""} onChange={(e) => setBoardId(e.target.value)}>
          {boardsQuery.data.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {boardId && <Link href={`/board/${boardId}/graph`}>Dependency graph →</Link>}
      </div>
      <div style={{ display: "flex", gap: 12, overflowX: "auto" }}>
        {PHASE_1_COLUMNS.map(({ state, title }) => (
          <Column
            key={state}
            state={state}
            title={title}
            cards={byState(state)}
            onDropCard={handleDrop}
            onCardClick={(card: Card) => {
              // Phase 1: no card detail page yet — placeholder for now.
              console.log("card clicked", card.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
