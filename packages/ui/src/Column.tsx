"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { CardState, CardWithStatus } from "@loopeng/shared";
import { canTransition } from "@loopeng/shared";
import { CardTile } from "./CardTile";
import { StatusDot } from "./components/status-badge";

export interface ColumnProps {
  state: CardState;
  title: string;
  cards: CardWithStatus[];
  onDropCard?: (cardId: string, toState: CardState) => void;
  onCardClick?: (card: CardWithStatus) => void;
  onCardWatchClick?: (card: CardWithStatus) => void;
  renderCardFooter?: (card: CardWithStatus) => ReactNode;
  draggingCardState?: CardState | null;
  onCardDragStart?: (card: CardWithStatus) => void;
  onCardDragEnd?: () => void;
  /** Card ids to visually flag as just-created (e.g. from intake), briefly pulsing. */
  highlightedCardIds?: ReadonlySet<string>;
  /** Lets callers keep a DOM ref per card (e.g. to scrollIntoView a highlighted card). */
  cardRef?: (cardId: string, el: HTMLDivElement | null) => void;
  children?: ReactNode;
}

export function Column({
  state,
  title,
  cards,
  onDropCard,
  onCardClick,
  onCardWatchClick,
  renderCardFooter,
  draggingCardState,
  onCardDragStart,
  onCardDragEnd,
  highlightedCardIds,
  cardRef,
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
        "flex min-h-0 w-[250px] shrink-0 flex-col rounded-[10px] border transition-colors duration-100",
        isDragOver ? "bg-primary/10 border-primary/50" : "bg-secondary/40 border-border",
        draggingCardState && !isValidTarget && !isDragOver ? "border-dashed border-muted-foreground/40 opacity-60" : "opacity-100",
      ].join(" ")}
    >
      <div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-2.5 pt-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        <StatusDot status={state} />
        {title} <span className="ml-auto rounded-full bg-card px-1.5 py-0.5 font-mono text-[11px] normal-case tracking-normal text-muted-foreground">{cards.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-2.5">
        {cards.map((card) => (
          <div
            key={card.id}
            ref={cardRef ? (el) => cardRef(card.id, el) : undefined}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/card-id", card.id);
              onCardDragStart?.(card);
            }}
            onDragEnd={() => onCardDragEnd?.()}
          >
            <CardTile
              card={card}
              onClick={onCardClick}
              onWatchClick={onCardWatchClick}
              draggable={false}
              highlighted={highlightedCardIds?.has(card.id)}
            />
            {renderCardFooter?.(card)}
          </div>
        ))}
      </div>
    </div>
  );
}
