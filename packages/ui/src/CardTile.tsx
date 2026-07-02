import type { Card } from "@loopeng/shared";
import { cn } from "./lib/utils";
import { Badge } from "./components/badge";

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
  card: Card;
  draggable?: boolean;
  onDragStart?: (card: Card) => void;
  onClick?: (card: Card) => void;
}

export function CardTile({ card, draggable = true, onDragStart, onClick }: CardTileProps) {
  return (
    <div
      draggable={draggable}
      onDragStart={() => onDragStart?.(card)}
      onClick={() => onClick?.(card)}
      className={cn(
        "mb-2 rounded-md border border-l-4 bg-card p-2.5 shadow-sm",
        RISK_BORDER_CLASS[card.riskTier],
        draggable ? "cursor-grab" : "cursor-pointer",
      )}
    >
      <div className="text-sm font-semibold">{card.title}</div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
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
    </div>
  );
}
