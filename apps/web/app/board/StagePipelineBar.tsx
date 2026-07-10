import type { CardState, CardWithStatus } from "@loopeng/shared";

// The clean happy-path progression. blocked/deploy_failed are both "stuck,
// needs recovery" states -- shown as a separate escape-hatch group instead
// of breaking up the main flow's left-to-right story.
const PIPELINE_STAGES: { state: CardState; label: string }[] = [
  { state: "backlog", label: "Backlog" },
  { state: "ready", label: "Ready" },
  { state: "in_progress", label: "In Progress" },
  { state: "in_review", label: "In Review" },
  { state: "gate_checks", label: "Gate Checks" },
  { state: "awaiting_approval", label: "Awaiting Approval" },
  { state: "deploying", label: "Deploying" },
  { state: "done", label: "Done" },
];

export function StagePipelineBar({ cards }: { cards: CardWithStatus[] }) {
  const countOf = (state: CardState) => cards.filter((c) => c.state === state).length;
  const escapeHatchCount = countOf("blocked") + countOf("deploy_failed");

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-6 pb-2.5 pt-3.5">
      {PIPELINE_STAGES.map((stage, i) => (
        <div key={stage.state} className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-card px-2.5 py-[3px] font-mono text-[11px] font-semibold text-muted-foreground">
            {stage.label} <span className="opacity-60">{countOf(stage.state)}</span>
          </div>
          {i < PIPELINE_STAGES.length - 1 && <span className="text-xs text-border">→</span>}
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
