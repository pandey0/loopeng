"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Column } from "@loopeng/ui";
import type { Card, CardState } from "@loopeng/shared";
import { api } from "../../lib/api";
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
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, overflowX: "auto", flex: 1 }}>
          {PHASE_3_COLUMNS.map(({ state, title }) => (
            <Column
              key={state}
              state={state}
              title={title}
              cards={byState(state)}
              onDropCard={handleDrop}
              onCardClick={(card: Card) => router.push(`/card/${card.id}`)}
              renderCardFooter={
                state === "awaiting_approval"
                  ? (card) => (
                      <button
                        onClick={() => handleApprove(card.id)}
                        style={{ fontSize: 11, padding: "4px 8px", marginTop: -4, marginBottom: 8, cursor: "pointer" }}
                      >
                        Approve → Deploy
                      </button>
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
