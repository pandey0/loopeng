"use client";

import type { CardWithStatus } from "@loopeng/shared";
import { AgentSessionPanel } from "../card/[cardId]/AgentSessionPanel";

export interface AgentSessionDrawerProps {
  card: CardWithStatus | null;
  onClose: () => void;
}

// 420px slide-in per the design, replacing the board's Dialog-hosted "watch"
// modal. Wraps the same AgentSessionPanel used everywhere else (card detail's
// own "View session" dialog, ApprovalDialog's reviewer transcript) -- reused
// as-is, not forked, via the panel's heightClassName override.
export function AgentSessionDrawer({ card, onClose }: AgentSessionDrawerProps) {
  if (!card?.activeAgentRun) return null;
  const run = card.activeAgentRun;

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-base">🛠️</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{card.title}</div>
        </div>
        {run.live && (
          <button
            type="button"
            disabled
            title="Stopping a run isn't supported yet"
            className="cursor-not-allowed rounded-md border border-destructive/40 px-2.5 py-1 font-mono text-[11px] font-semibold text-destructive/50"
          >
            ■ Stop
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 p-4">
        <AgentSessionPanel agentRunId={run.agentRunId} roleName={run.roleName} live={run.live} heightClassName="h-full" />
      </div>
    </div>
  );
}
