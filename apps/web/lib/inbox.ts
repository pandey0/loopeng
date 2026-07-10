import { isHumanBlocked } from "@loopeng/ui";
import type { CardWithStatus } from "@loopeng/shared";

export type InboxKind = "approval" | "question" | "blocked";

export interface InboxItem {
  card: CardWithStatus;
  kind: InboxKind;
  detail: string;
}

// Single source of truth for "what's actually waiting on a human" -- the
// Inbox page renders these, and the sidebar's Inbox badge counts them.
// Previously the sidebar badge showed useNotifications().unreadCount
// instead, which is a completely different number (activity events seen
// over the live SSE stream since the page happened to mount) -- it could
// read "2" while this list was empty, or vice versa.
export function buildInboxItems(cards: CardWithStatus[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const card of cards) {
    if (card.state === "awaiting_approval") {
      items.push({ card, kind: "approval", detail: card.blockedReason ? card.blockedReason : "Ready for review" });
    } else if (card.blockedReason && isHumanBlocked(card.blockedReason)) {
      items.push({ card, kind: "question", detail: card.blockedReason });
    } else if (card.state === "blocked") {
      items.push({ card, kind: "blocked", detail: card.blockedReason ?? "Blocked" });
    }
  }
  return items;
}
