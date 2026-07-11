"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { CardState, CardWithStatus } from "@loopeng/shared";
import { canTransition } from "@loopeng/shared";
import { CardTile } from "./CardTile";
import { StatusDot } from "./components/status-badge";
import { cn } from "./lib/utils";

interface CardGroup {
  epicId: string | null;
  epicTitle: string | null;
  cards: CardWithStatus[];
}

// Clusters a column's cards by the epic they were decomposed from (first
// "relates_to" edge -- see computeDependencyInfo in board-engine) so
// siblings from the same plan sit together instead of interleaved with
// unrelated work. Within a group, cards with an unmet "blocks" dependency
// sort after their clear siblings -- a simple "what can actually start"
// ordering, not a full topological sort (real chains beyond one level are
// rare for a planner-sized epic). Cards with no epic keep their original
// relative order, grouped last.
function groupAndOrderCards(cards: CardWithStatus[]): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  const order: string[] = [];
  const ungrouped: CardWithStatus[] = [];

  for (const card of cards) {
    const epicId = card.dependencyInfo.epicId;
    if (!epicId) {
      ungrouped.push(card);
      continue;
    }
    let group = groups.get(epicId);
    if (!group) {
      group = { epicId, epicTitle: card.dependencyInfo.epicTitle, cards: [] };
      groups.set(epicId, group);
      order.push(epicId);
    }
    group.cards.push(card);
  }

  for (const group of groups.values()) {
    group.cards.sort((a, b) => a.dependencyInfo.blockingCards.length - b.dependencyInfo.blockingCards.length);
  }

  const result = order.map((id) => groups.get(id)!);
  if (ungrouped.length > 0) result.push({ epicId: null, epicTitle: null, cards: ungrouped });
  return result;
}

// Stable per-epic accent so the same epic's left-border strip matches
// across every column it has cards in -- hashed from the id (not random)
// so it doesn't shift between renders.
const EPIC_BORDER_CLASSES = ["border-l-primary", "border-l-violet-400", "border-l-warning", "border-l-sky-400", "border-l-success"];
function epicBorderClass(epicId: string): string {
  let hash = 0;
  for (let i = 0; i < epicId.length; i++) hash = (hash * 31 + epicId.charCodeAt(i)) | 0;
  return EPIC_BORDER_CLASSES[Math.abs(hash) % EPIC_BORDER_CLASSES.length]!;
}

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
  /** Card id under keyboard (j/k) navigation focus, if any. */
  focusedCardId?: string | null;
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
  focusedCardId,
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
        {groupAndOrderCards(cards).map((group) => (
          <div
            key={group.epicId ?? "__ungrouped"}
            className={group.epicId ? cn("mb-2 border-l-2 pl-1.5", epicBorderClass(group.epicId)) : undefined}
          >
            {group.epicId && (
              <div
                className="mb-1 truncate px-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                title={group.epicTitle ?? undefined}
              >
                {group.epicTitle}
              </div>
            )}
            {group.cards.map((card) => (
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
                  focused={focusedCardId === card.id}
                />
                {renderCardFooter?.(card)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
