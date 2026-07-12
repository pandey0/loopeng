export interface ShortcutEntry {
  keys: string;
  label: string;
}

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "j / k", label: "Next / previous card" },
  { keys: "a", label: "Approve focused card" },
  { keys: "/", label: "Focus title search" },
  { keys: "esc", label: "Close panel / dialog" },
  { keys: "?", label: "Toggle this help" },
];
