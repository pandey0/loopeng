"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, { Background, Controls, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { api } from "../../../../lib/api";

export default function DependencyGraphPage({ params }: { params: { boardId: string } }) {
  const { boardId } = params;
  const cardsQuery = useQuery({ queryKey: ["cards", boardId], queryFn: () => api.listCards(boardId) });
  const [edges, setEdges] = useState<Edge[]>([]);

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
    <div style={{ height: "80vh", border: "1px solid #e2e8f0", borderRadius: 8 }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
