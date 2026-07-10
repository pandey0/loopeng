"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, { Background, BackgroundVariant, Controls, Panel, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { api } from "../../../../lib/api";
import { useBoard } from "../../../providers/BoardProvider";

// SVG strokes can't read CSS custom properties reliably across browsers, so
// these are hand-converted from the .theme-dark HSL tokens in globals.css
// (--destructive: 3 90% 65%, --muted-foreground: 220 10% 45%) rather than
// picked freehand -- keeps the edges visually in sync with the rest of the
// dark theme even though ReactFlow needs literal color values.
const BLOCKS_STROKE = "#f65d55"; // hsl(var(--destructive)) in .theme-dark
const RELATES_TO_STROKE = "#676f7e"; // hsl(var(--muted-foreground)) in .theme-dark

// Next.js 15 passes route params as a Promise even to client components —
// React's use() hook unwraps it without needing an async wrapper component.
export default function DependencyGraphPage({ params }: { params: Promise<{ boardId: string }> }) {
  const { boardId } = use(params);
  const { boardId: currentBoardId, setBoardId } = useBoard();
  const router = useRouter();
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
          const isBlocks = dep.dependencyType === "blocks";
          allEdges.push({
            id: `${dep.cardId}-${dep.dependsOnCardId}`,
            source: dep.dependsOnCardId,
            target: dep.cardId,
            label: dep.dependencyType,
            style: {
              stroke: isBlocks ? BLOCKS_STROKE : RELATES_TO_STROKE,
              strokeWidth: isBlocks ? 1.5 : 1.25,
              strokeDasharray: isBlocks ? undefined : "5 4",
            },
          });
        }
      }
      if (!cancelled) setEdges(allEdges);
    })();
    return () => {
      cancelled = true;
    };
  }, [cardsQuery.data]);

  if (cardsQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const nodes: Node[] = (cardsQuery.data ?? []).map((card, i) => ({
    id: card.id,
    position: { x: (i % 5) * 220, y: Math.floor(i / 5) * 130 },
    data: {
      label: (
        <div className="flex flex-col gap-1.5 text-left">
          <div className="flex flex-wrap items-center gap-1">
            {/* Mockup's column badge is a single flat mono pill showing the raw
                state key (e.g. "in_progress"), not the humanized/colored
                StatusBadge used elsewhere in the app -- kept deliberately
                separate from that component so this graph matches the design
                literally instead of inheriting the board's per-status tones. */}
            <span className="rounded bg-[#1c2530] px-[5px] py-[1px] font-mono text-[9.5px] text-[#8b949e]">{card.state}</span>
            {card.touchesArchitecture && (
              <span className="rounded bg-[#241a33] px-[5px] py-[1px] font-mono text-[9.5px] font-semibold text-[#a78bfa]">
                ADR
              </span>
            )}
          </div>
          <div className="text-[12.5px] font-semibold leading-[1.3] text-foreground">{card.title}</div>
        </div>
      ),
    },
    style: {
      width: 190,
      padding: "10px 12px",
      textAlign: "left",
      borderRadius: 9,
      background: "hsl(var(--card))",
      borderColor: "hsl(var(--border))",
      color: "hsl(var(--card-foreground))",
      cursor: "pointer",
    },
  }));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Header bar matches the mockup's dedicated bordered strip (16px/24px
          padding, hairline border-bottom) rather than a bare page title, so
          it reads as a fixed toolbar above the full-bleed graph canvas. */}
      <div className="shrink-0 border-b border-[#1c212c] px-6 py-4">
        <div className="text-base font-bold text-foreground">Dependency graph</div>
        <div className="mt-0.5 text-[13px] text-muted-foreground">
          blocks / relates_to relationships between cards on this board. Click a node to open its card.
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          onNodeClick={(_, node) => router.push(`/card/${node.id}`)}
          proOptions={{ hideAttribution: true }}
        >
          {/* size is in flow-space units, so at fitView's typical zoomed-out
              scale a size of 1 renders as a sub-pixel, effectively invisible
              dot. Bumped so the dotted grid -- called out in the mockup as
              this page's distinctive background -- actually shows up. */}
          <Background variant={BackgroundVariant.Dots} gap={24} size={3} color="hsl(var(--border))" />
          <Controls
            position="bottom-right"
            showInteractive={false}
            className="!rounded-md !border !border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button]:!fill-foreground [&_button]:hover:!bg-accent"
          />
          <Panel
            position="bottom-left"
            className="!m-3 flex flex-col gap-1.5 rounded-md border border-border bg-card px-3.5 py-2 text-[11.5px] text-muted-foreground"
          >
            <div className="flex items-center gap-2">
              <span className="inline-block h-0 w-4 border-t-2" style={{ borderColor: BLOCKS_STROKE }} />
              blocks
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: RELATES_TO_STROKE }} />
              relates_to
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}
