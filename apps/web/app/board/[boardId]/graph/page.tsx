"use client";

import { use, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, { Background, Controls, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { api } from "../../../../lib/api";
import { useBoard } from "../../../providers/BoardProvider";

// Next.js 15 passes route params as a Promise even to client components —
// React's use() hook unwraps it without needing an async wrapper component.
export default function DependencyGraphPage({ params }: { params: Promise<{ boardId: string }> }) {
  const { boardId } = use(params);
  const { boardId: currentBoardId, setBoardId } = useBoard();
  const cardsQuery = useQuery({ queryKey: ["cards", boardId], queryFn: () => api.listCards(boardId) });
  const [edges, setEdges] = useState<Edge[]>([]);

  // Keep the top bar's board switcher in sync with whichever board's graph
  // is currently open, so it reflects this page even if reached by URL.
  useEffect(() => {
    if (currentBoardId !== boardId) setBoardId(boardId);
  }, [boardId, currentBoardId, setBoardId]);

  useEffect(() => {
    if (!cardsQuery.data) return;
    let cancelled = false;
    (async () => {
      const allEdges: Edge[] = [];
      for (const card of cardsQuery.data!) {
        const deps = await api.listCardDependencies(card.id);
        for (const dep of deps) {
          allEdges.push({
            id: `${dep.cardId}-${dep.dependsOnCardId}`,
            source: dep.dependsOnCardId,
            target: dep.cardId,
            label: dep.dependencyType,
            animated: dep.dependencyType === "blocks",
          });
        }
      }
      if (!cancelled) setEdges(allEdges);
    })();
    return () => {
      cancelled = true;
    };
  }, [cardsQuery.data]);

  if (cardsQuery.isLoading) return <p>Loading...</p>;

  const nodes: Node[] = (cardsQuery.data ?? []).map((card, i) => ({
    id: card.id,
    position: { x: (i % 5) * 220, y: Math.floor(i / 5) * 120 },
    data: { label: card.title },
    style: { fontSize: 12, width: 180 },
  }));

  return (
    <div className="h-[80vh] rounded-lg border">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
