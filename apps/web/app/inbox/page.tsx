"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { cn, isHumanBlocked } from "@loopeng/ui";
import type { CardWithStatus } from "@loopeng/shared";
import { api } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";

type InboxKind = "approval" | "question" | "blocked";

interface InboxItem {
  card: CardWithStatus;
  kind: InboxKind;
  detail: string;
}

type Filter = "all" | InboxKind;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "approval", label: "Approvals" },
  { key: "question", label: "Questions" },
  { key: "blocked", label: "Blocked" },
];

// Design source tints the icon square and the kind badge with the same
// color family: amber for approval/blocked, purple for question. The app
// has no dedicated purple design token (see docs/page.tsx's DOC_TYPE_BADGE_CLASS
// comment), so question reuses the same one-off violet-500 tint that page
// already established for its "adr" doc type, matching precedent.
const KIND_META: Record<InboxKind, { icon: string; tint: string; badgeLabel: string; cta: string }> = {
  approval: { icon: "🚀", tint: "bg-warning/15 text-warning", badgeLabel: "approval", cta: "Review →" },
  question: { icon: "❓", tint: "bg-violet-500/15 text-violet-400", badgeLabel: "question", cta: "Answer →" },
  blocked: { icon: "⚠", tint: "bg-warning/15 text-warning", badgeLabel: "blocked", cta: "View →" },
};

// Waiting on answer: "waiting on answer: <question>" -- strip the machine
// prefix so the human only sees the actual question text.
const HUMAN_BLOCKED_PREFIX = "waiting on answer:";
function stripQuestionPrefix(reason: string): string {
  return reason.startsWith(HUMAN_BLOCKED_PREFIX) ? reason.slice(HUMAN_BLOCKED_PREFIX.length).trim() : reason;
}

function buildInboxItems(cards: CardWithStatus[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const card of cards) {
    if (card.state === "awaiting_approval") {
      items.push({
        card,
        kind: "approval",
        detail: card.blockedReason ? card.blockedReason : "Ready for review",
      });
    } else if (card.blockedReason && isHumanBlocked(card.blockedReason)) {
      items.push({ card, kind: "question", detail: stripQuestionPrefix(card.blockedReason) });
    } else if (card.state === "blocked") {
      items.push({ card, kind: "blocked", detail: card.blockedReason ?? "Blocked" });
    }
  }
  return items;
}

export default function InboxPage() {
  const router = useRouter();
  const { boardId, boards } = useBoard();
  const [filter, setFilter] = useState<Filter>("all");
  const boardName = boards.find((b) => b.id === boardId)?.name;

  const cardsQuery = useQuery({
    queryKey: ["cards", boardId],
    queryFn: () => api.listCards(boardId!),
    enabled: !!boardId,
  });

  const items = useMemo(() => buildInboxItems(cardsQuery.data ?? []), [cardsQuery.data]);

  const counts = useMemo(
    () => ({
      all: items.length,
      approval: items.filter((i) => i.kind === "approval").length,
      question: items.filter((i) => i.kind === "question").length,
      blocked: items.filter((i) => i.kind === "blocked").length,
    }),
    [items],
  );

  const filteredItems = filter === "all" ? items : items.filter((i) => i.kind === filter);

  return (
    <div className="flex h-full min-w-0 flex-1 justify-center overflow-y-auto">
      <div className="w-full max-w-[760px] p-8 pb-20">
        <h1 className="mb-1.5 text-[22px] font-bold">Inbox</h1>
        <p className="mb-7 text-sm text-muted-foreground">
          Everything waiting on a human decision, across every card{boardName ? ` on ${boardName}` : " on this board"}.
        </p>

        <div className="mb-6 flex flex-wrap gap-2">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
                filter === key
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:bg-secondary/80",
              )}
            >
              {label} {counts[key]}
            </button>
          ))}
        </div>

        {cardsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : filteredItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {filteredItems.map(({ card, kind, detail }) => {
              const meta = KIND_META[kind];
              return (
                <li
                  key={card.id}
                  className="flex cursor-pointer items-start gap-3.5 rounded-[10px] border border-border bg-card px-[18px] py-4"
                  onClick={() => router.push(`/card/${card.id}`)}
                >
                  <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base", meta.tint)}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("shrink-0 rounded px-[7px] py-[2px] font-mono text-[10.5px] font-semibold", meta.tint)}>
                        {meta.badgeLabel}
                      </span>
                      <span className="truncate text-[13.5px] font-semibold">{card.title}</span>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-[1.5] text-foreground/80">{detail}</p>
                    <p className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
                      {new Date(card.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/card/${card.id}`);
                    }}
                    className="shrink-0 whitespace-nowrap text-xs font-bold text-primary"
                  >
                    {meta.cta}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
