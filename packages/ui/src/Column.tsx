import { useState } from "react";
import type { ReactNode } from "react";
import type { Card, CardState } from "@loopeng/shared";
import { canTransition } from "@loopeng/shared";
import { CardTile } from "./CardTile";

export interface ColumnProps {
  state: CardState;
  title: string;
  cards: Card[];
  onDropCard?: (cardId: string, toState: CardState) => void;
  onCardClick?: (card: Card) => void;
  renderCardFooter?: (card: Card) => ReactNode;
  draggingCardState?: CardState | null;
  onCardDragStart?: (card: Card) => void;
  onCardDragEnd?: () => void;
  children?: ReactNode;
}

export function Column({
  state,
  title,
  cards,
  onDropCard,
  onCardClick,
  renderCardFooter,
  draggingCardState,
  onCardDragStart,
  onCardDragEnd,
}: ColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isValidTarget = draggingCardState ? canTransition(draggingCardState, state) : true;

  return (
    <div
      onDragOver={(e) => {
        if (!isValidTarget) return;
        e.preventDefault();
      }}
      onDragEnter={() => {
        if (isValidTarget) setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        setIsDragOver(false);
        if (!isValidTarget) return;
        const cardId = e.dataTransfer.getData("text/card-id");
        if (cardId) onDropCard?.(cardId, state);
      }}
      style={{
        minWidth: 220,
        flex: "1 0 220px",
        background: isDragOver ? "#e6fffa" : "#f7fafc",
        border: draggingCardState && !isValidTarget ? "1px dashed #cbd5e0" : "1px solid transparent",
        borderRadius: 8,
        padding: 10,
        opacity: draggingCardState && !isValidTarget ? 0.6 : 1,
        transition: "background 100ms ease, opacity 100ms ease",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#4a5568", marginBottom: 8 }}>
        {title} <span style={{ color: "#a0aec0" }}>({cards.length})</span>
      </div>
      {cards.map((card) => (
        <div
          key={card.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/card-id", card.id);
            onCardDragStart?.(card);
          }}
          onDragEnd={() => onCardDragEnd?.()}
        >
          <CardTile card={card} onClick={onCardClick} draggable={false} />
          {renderCardFooter?.(card)}
        </div>
      ))}
    </div>
  );
}
