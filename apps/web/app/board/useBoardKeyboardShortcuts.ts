import { useEffect, useState } from "react";
import type { CardWithStatus } from "@loopeng/shared";

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA"]);

// Exported for unit testing without a DOM: true when the event target is
// already a text input/textarea, so single-letter shortcuts (j/k/a/?/`/`)
// shouldn't fire while the user is typing into it.
export function isTypingTarget(target: { tagName: string } | null | undefined): boolean {
  return !!target && TYPING_TAGS.has(target.tagName);
}

export interface BoardKeyboardShortcuts {
  focusedCardId: string | null;
  shortcutsOpen: boolean;
  closeShortcuts: () => void;
}

// j/k move focus through the flattened, column-ordered card list; a
// approves the focused card if it's actually approvable; / focuses the
// title search box; ? toggles the shortcuts help dialog. Pure client
// interaction over the existing transitionCard/approve flow -- no new
// mutation path, just keyboard triggers for the buttons that already exist.
export function useBoardKeyboardShortcuts(
  flatCards: CardWithStatus[],
  onApproveFocused: (cardId: string) => void,
  onFocusSearch: () => void,
): BoardKeyboardShortcuts {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (isTypingTarget(target)) return;

      if (e.key === "/") {
        e.preventDefault();
        onFocusSearch();
        return;
      }
      if (e.key === "?") {
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setShortcutsOpen(false);
        return;
      }
      if (!flatCards.length) return;

      if (e.key === "j" || e.key === "k") {
        const curIdx = flatCards.findIndex((c) => c.id === focusedCardId);
        let next: number;
        if (e.key === "j") next = curIdx < 0 ? 0 : Math.min(curIdx + 1, flatCards.length - 1);
        else next = curIdx < 0 ? 0 : Math.max(curIdx - 1, 0);
        setFocusedCardId(flatCards[next]!.id);
        return;
      }
      if (e.key === "a") {
        const focused = flatCards.find((c) => c.id === focusedCardId);
        if (focused?.state === "awaiting_approval") onApproveFocused(focused.id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flatCards, focusedCardId, onApproveFocused, onFocusSearch]);

  return { focusedCardId, shortcutsOpen, closeShortcuts: () => setShortcutsOpen(false) };
}
