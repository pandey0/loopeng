"use client";

import { Dialog } from "@loopeng/ui";

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "j / k", label: "Next / previous card" },
  { keys: "a", label: "Approve focused card" },
  { keys: "esc", label: "Close panel / dialog" },
  { keys: "?", label: "Toggle this help" },
];

export function ShortcutsHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" className="max-w-sm">
      <div className="flex flex-col gap-2.5 text-sm">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="flex items-center justify-between">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-mono text-foreground">{s.keys}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
