import type { Card } from "@loopeng/shared";

const RISK_COLOR: Record<Card["riskTier"], string> = {
  low: "#2f855a",
  medium: "#b7791f",
  high: "#c53030",
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
      style={{
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${RISK_COLOR[card.riskTier]}`,
        borderRadius: 6,
        padding: "8px 10px",
        marginBottom: 8,
        background: "#fff",
        cursor: draggable ? "grab" : "pointer",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{card.title}</div>
      <div style={{ fontSize: 11, color: "#718096", marginTop: 4, display: "flex", gap: 8 }}>
        <span>{card.cardType}</span>
        <span>P{card.priority}</span>
        {card.touchesArchitecture && <span title="touches architecture">ADR</span>}
      </div>
    </div>
  );
}
