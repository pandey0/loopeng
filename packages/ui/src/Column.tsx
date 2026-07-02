"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { Card, CardState } from "@loopeng/shared";
import { canTransition } from "@loopeng/shared";
import { CardTile } from "./CardTile";
import { StatusDot } from "./components/status-badge";

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
      className={[
        "min-w-[220px] flex-[1_0_220px] rounded-lg p-2.5 border transition-colors duration-100",
        isDragOver ? "bg-teal-50" : "bg-muted",
        draggingCardState && !isValidTarget ? "border-dashed border-muted-foreground/40 opacity-60" : "border-transparent opacity-100",
      ].join(" ")}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-muted-foreground">
        <StatusDot status={state} />
        {title} <span className="text-muted-foreground/70">({cards.length})</span>
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
