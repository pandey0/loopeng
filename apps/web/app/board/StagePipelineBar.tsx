import type { CardState, CardWithStatus } from "@loopeng/shared";
import { getStatusMeta } from "@loopeng/ui";

// The clean happy-path progression. blocked/deploy_failed are both "stuck,
// needs recovery" states -- shown as a separate escape-hatch group instead
// of breaking up the main flow's left-to-right story.
//
// Labels come from getStatusMeta (the same map the card detail page's
// StatusBadge reads) rather than being spelled out here, so this bar can't
// drift from what a card's detail view shows for that same state.
const PIPELINE_STAGE_STATES: CardState[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "gate_checks",
  "awaiting_approval",
  "deploying",
  "done",
];

export function StagePipelineBar({ cards }: { cards: CardWithStatus[] }) {
  const countOf = (state: CardState) => cards.filter((c) => c.state === state).length;
  const escapeHatchCount = countOf("blocked") + countOf("deploy_failed");

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-6 pb-2.5 pt-3.5">
      {PIPELINE_STAGE_STATES.map((state, i) => (
        <div key={state} className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-card px-2.5 py-[3px] font-mono text-[11px] font-semibold text-muted-foreground">
            {getStatusMeta(state).label} <span className="opacity-60">{countOf(state)}</span>
          </div>
          {i < PIPELINE_STAGE_STATES.length - 1 && <span className="text-xs text-border">→</span>}
        </div>
      ))}
      <div className="ml-2.5 flex shrink-0 items-center gap-1.5 border-l border-dashed border-border pl-2.5">
        <span className="font-mono text-[10.5px] text-muted-foreground">escape hatch</span>
        <span className="text-[11px] text-muted-foreground">┄→</span>
        <div className="whitespace-nowrap rounded-full bg-warning/10 px-2.5 py-[3px] font-mono text-[11px] font-semibold text-warning">
          blocked {escapeHatchCount}
        </div>
      </div>
    </div>
  );
}
