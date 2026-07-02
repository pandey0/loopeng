import type { ReactNode } from "react";
import type { Card, CardState } from "@loopeng/shared";
import { CardTile } from "./CardTile";

export interface ColumnProps {
  state: CardState;
  title: string;
  cards: Card[];
  onDropCard?: (cardId: string, toState: CardState) => void;
  onCardClick?: (card: Card) => void;
  renderCardFooter?: (card: Card) => ReactNode;
  children?: ReactNode;
}

export function Column({ state, title, cards, onDropCard, onCardClick, renderCardFooter }: ColumnProps) {
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const cardId = e.dataTransfer.getData("text/card-id");
        if (cardId) onDropCard?.(cardId, state);
      }}
      className="min-w-[220px] flex-[1_0_220px] rounded-lg bg-muted p-2.5"
    >
      <div className="mb-2 text-xs font-bold uppercase text-muted-foreground">
        {title} <span className="text-muted-foreground/70">({cards.length})</span>
      </div>
      {cards.map((card) => (
        <div key={card.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/card-id", card.id)}>
          <CardTile card={card} onClick={onCardClick} draggable={false} />
          {renderCardFooter?.(card)}
        </div>
      ))}
    </div>
  );
}
