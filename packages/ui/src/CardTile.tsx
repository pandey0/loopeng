import type { Card, CardWithStatus } from "@loopeng/shared";
import { cn } from "./lib/utils";
import { LiveIndicator } from "./components/live-indicator";
import { getStatusMeta } from "./lib/status";
import { isHumanBlocked } from "./lib/blocked-reason";

const RISK_DOT_CLASS: Record<Card["riskTier"], string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};

// priority is a bare integer (no fixed range in the schema) -- threshold
// tone instead of a lookup table so arbitrary values degrade gracefully
// instead of falling through an unmapped enum key.
function priorityBadgeClass(priority: number): string {
  if (priority <= 1) return "bg-destructive/15 text-destructive";
  if (priority === 2) return "bg-warning/15 text-warning";
  return "bg-secondary text-muted-foreground";
}

export interface CardTileProps {
  card: CardWithStatus;
  draggable?: boolean;
  /** Briefly flags a just-created card (e.g. from intake) so it's easy to spot on the board. */
  highlighted?: boolean;
  onDragStart?: (card: CardWithStatus) => void;
  onClick?: (card: CardWithStatus) => void;
  /** Opens a live session view for the card's active run without navigating off the board — only shown when a live session is actually attachable. */
  onWatchClick?: (card: CardWithStatus) => void;
}

export function CardTile({ card, draggable = true, highlighted = false, onDragStart, onClick, onWatchClick }: CardTileProps) {
  const status = getStatusMeta(card.state);
  const activeAgentRun = card.activeAgentRun ?? null;
  const isActive = activeAgentRun !== null;
  const humanBlocked = isHumanBlocked(card.blockedReason);
  return (
    <div
      draggable={draggable}
      onDragStart={() => onDragStart?.(card)}
      onClick={() => onClick?.(card)}
      className={cn(
        "mb-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-muted-foreground/40",
        draggable ? "cursor-grab" : "cursor-pointer",
        isActive && "ring-1 ring-primary/50",
        highlighted && "ring-2 ring-primary animate-pulse",
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{card.cardType}</span>
        <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold", priorityBadgeClass(card.priority))}>
          P{card.priority}
        </span>
        {card.touchesArchitecture && (
          <span title="touches architecture" className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-foreground">
            ADR
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", RISK_DOT_CLASS[card.riskTier])} />
          <span className="font-mono text-[10px] text-muted-foreground">{card.riskTier}</span>
        </span>
      </div>

      <div className="mb-1.5 flex items-center gap-1.5 text-[13.5px] font-semibold leading-snug">
        <span title={status.label}>
          <status.Icon className={cn("h-3 w-3 shrink-0", status.textClassName)} />
        </span>
        {card.title}
      </div>

      {card.blockedReason && (
        <div
          className={cn(
            "mb-1.5 rounded-md p-2 text-[11.5px] leading-snug",
            humanBlocked ? "bg-warning/10 text-warning" : "bg-secondary text-muted-foreground",
          )}
        >
          {humanBlocked ? "⚠" : "⏳"} {card.blockedReason}
          <div className="mt-0.5 font-mono text-[9.5px] opacity-75">
            {humanBlocked ? "needs a human" : "auto-retries when unblocked"}
          </div>
        </div>
      )}

      {isActive && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-secondary p-2">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-primary">{activeAgentRun?.roleName ?? "agent"}</span>
          {activeAgentRun?.snippet && (
            <span className="flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={activeAgentRun.snippet}>
              {activeAgentRun.snippet}
            </span>
          )}
          {activeAgentRun?.live && <LiveIndicator className="ml-1 shrink-0" />}
        </div>
      )}

      {onWatchClick && activeAgentRun?.live && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onWatchClick(card);
          }}
          className="text-[11.5px] font-semibold text-primary hover:underline"
        >
          watch →
        </button>
      )}
    </div>
  );
}
