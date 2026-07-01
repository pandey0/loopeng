import type { ReactNode } from "react";
import type { Card, CardState } from "@loopeng/shared";
import { CardTile } from "./CardTile";

export interface ColumnProps {
  state: CardState;
  title: string;
  cards: Card[];
  onDropCard?: (cardId: string, toState: CardState) => void;
  onCardClick?: (card: Card) => void;
  children?: ReactNode;
}

export function Column({ state, title, cards, onDropCard, onCardClick }: ColumnProps) {
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const cardId = e.dataTransfer.getData("text/card-id");
        if (cardId) onDropCard?.(cardId, state);
      }}
      style={{
        minWidth: 220,
        flex: "1 0 220px",
        background: "#f7fafc",
        borderRadius: 8,
        padding: 10,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#4a5568", marginBottom: 8 }}>
        {title} <span style={{ color: "#a0aec0" }}>({cards.length})</span>
      </div>
      {cards.map((card) => (
        <div
          key={card.id}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/card-id", card.id)}
        >
          <CardTile card={card} onClick={onCardClick} draggable={false} />
        </div>
      ))}
    </div>
  );
}
