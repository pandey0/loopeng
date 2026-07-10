import { useEffect, useState } from "react";
import type { CardWithStatus } from "@loopeng/shared";

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA"]);

export interface BoardKeyboardShortcuts {
  focusedCardId: string | null;
  shortcutsOpen: boolean;
  closeShortcuts: () => void;
}

// j/k move focus through the flattened, column-ordered card list; a
// approves the focused card if it's actually approvable; ? toggles the
// shortcuts help dialog. Pure client interaction over the existing
// transitionCard/approve flow -- no new mutation path, just keyboard
// triggers for the buttons that already exist.
export function useBoardKeyboardShortcuts(
  flatCards: CardWithStatus[],
  onApproveFocused: (cardId: string) => void,
): BoardKeyboardShortcuts {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && TYPING_TAGS.has(target.tagName)) return;

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
  }, [flatCards, focusedCardId, onApproveFocused]);

  return { focusedCardId, shortcutsOpen, closeShortcuts: () => setShortcutsOpen(false) };
}
