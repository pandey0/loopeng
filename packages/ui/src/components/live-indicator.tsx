import { cn } from "../lib/utils";

export interface LiveIndicatorProps {
  /** Visible text next to the dot; defaults to "live". Pass null to render the dot alone. */
  label?: string | null;
  className?: string;
}

// The "this run has an attachable interactive session right now" marker —
// stricter than a running status badge (which is DB-derived and survives API
// restarts). One shared component so the board tile and the Activity tab's
// agent runs list can't drift apart visually.
export function LiveIndicator({ label = "live", className }: LiveIndicatorProps) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-success", className)}>
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      {label}
    </span>
  );
}
