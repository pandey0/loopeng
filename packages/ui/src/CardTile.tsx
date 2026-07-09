import type { Card, CardWithStatus } from "@loopeng/shared";
import { cn } from "./lib/utils";
import { Badge } from "./components/badge";
import { LiveIndicator } from "./components/live-indicator";
import { getStatusMeta } from "./lib/status";

const RISK_BORDER_CLASS: Record<Card["riskTier"], string> = {
  low: "border-l-success",
  medium: "border-l-warning",
  high: "border-l-destructive",
};

const RISK_BADGE_VARIANT: Record<Card["riskTier"], "success" | "warning" | "destructive"> = {
  low: "success",
  medium: "warning",
  high: "destructive",
};

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
  return (
    <div
      draggable={draggable}
      onDragStart={() => onDragStart?.(card)}
      onClick={() => onClick?.(card)}
      className={cn(
        "mb-2 rounded-md border border-l-4 bg-card p-2.5 shadow-sm transition-shadow",
        RISK_BORDER_CLASS[card.riskTier],
        draggable ? "cursor-grab" : "cursor-pointer",
        isActive && "ring-1 ring-primary/50",
        highlighted && "ring-2 ring-primary animate-pulse",
      )}
    >
      <div className="text-sm font-semibold">{card.title}</div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span title={status.label}>
          <status.Icon className={cn("h-3 w-3 shrink-0", status.textClassName)} />
        </span>
        <span>{card.cardType}</span>
        <span>P{card.priority}</span>
        <Badge variant={RISK_BADGE_VARIANT[card.riskTier]} className="px-1.5 py-0 text-[10px]">
          {card.riskTier}
        </Badge>
        {card.touchesArchitecture && (
          <span title="touches architecture" className="font-semibold">
            ADR
          </span>
        )}
      </div>
      {card.blockedReason && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-destructive">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
          {card.state === "deploy_failed" ? "Deploy failed" : "Blocked"}: {card.blockedReason}
        </div>
      )}
      {isActive && (
        <div className="mt-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            {activeAgentRun?.roleName ?? "agent"} {activeAgentRun?.status}
            {activeAgentRun?.live && <LiveIndicator className="ml-1" />}
            {onWatchClick && activeAgentRun?.live && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onWatchClick(card);
                }}
                className="ml-auto text-[10px] font-normal text-muted-foreground underline hover:text-foreground"
              >
                watch
              </button>
            )}
          </div>
          {activeAgentRun?.snippet && (
            <div className="mt-0.5 truncate text-[11px] italic text-muted-foreground" title={activeAgentRun.snippet}>
              {activeAgentRun.snippet}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
