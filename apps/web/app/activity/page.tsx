"use client";

import Link from "next/link";
import type { CardState } from "@loopeng/shared";
import { cn, getStatusMeta } from "@loopeng/ui";
import { useBoard } from "../providers/BoardProvider";
import { useNotifications, type NotificationEvent } from "../providers/NotificationProvider";
import { describeEvent } from "../../lib/events";

// A colored dot per row, reusing the same state-color vocabulary already
// shown on cards/columns (StatusBadge, CardTile) rather than inventing a new
// palette. card.moved carries the real destination CardState in its payload,
// so that dot is exact; other event types get a reasonable tone bucket that
// mirrors the destructive/warning/success groupings toHighSignalToast
// already uses to decide which events are worth a toast.
function eventDotClass(event: NotificationEvent): string {
  if (event.eventType === "card.moved") {
    const { to } = event.payload as { to?: string };
    if (to) return getStatusMeta(to as CardState).dotClassName;
  }
  if (event.eventType === "card.question_raised") return "bg-destructive";
  if (event.eventType.startsWith("gate.") && event.eventType.endsWith("failed")) return "bg-destructive";
  if (event.eventType.startsWith("deploy.") && event.eventType.includes("live")) return "bg-success";
  if (event.eventType === "card.awaiting_deploy" || event.eventType === "doc.drift_detected") return "bg-warning";
  if (event.eventType === "card.epic_reviewed") return "bg-primary";
  return "bg-muted-foreground";
}

export default function ActivityPage() {
  const { boardId, boards } = useBoard();
  const { events } = useNotifications();
  const boardName = boards.find((b) => b.id === boardId)?.name;

  return (
    // AppShell's <main> is unpadded/overflow-hidden and expects each page to
    // own its own scroll region -- this was previously missing here, so
    // anything past the first viewport of events was unreachable. Mirrors
    // the mockup's `flex:1; overflow-y:auto; padding:28px 32px 60px;`.
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-[60px] pt-7">
      <div className="mx-auto max-w-[760px]">
        <h1 className="mb-1 text-xl font-bold text-foreground">Activity</h1>
        <p className="mb-6 text-[13px] text-muted-foreground">
          {boardName ? `Everything that happened on ${boardName}, newest first.` : "Everything that happened, newest first."}
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {events.map((event) => {
              const row = (
                <div className="flex items-start gap-3 px-1 py-[13px]">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", eventDotClass(event))} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] leading-normal text-foreground">{describeEvent(event)}</div>
                    <div className="mt-[3px] font-mono text-[11px] text-muted-foreground">
                      {new Date(event.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              );
              return (
                <li key={event.id} className="border-b border-[#1c212c] last:border-b-0">
                  {event.entityType === "card" ? (
                    <Link href={`/card/${event.entityId}`} className="block cursor-pointer hover:bg-accent">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
