"use client";

import Link from "next/link";
import { useNotifications } from "../providers/NotificationProvider";
import { describeEvent } from "../../lib/events";

// Reads from the single app-wide NotificationProvider (mounted once in
// layout.tsx) instead of opening its own EventSource — see the acceptance
// criteria: only one SSE connection to /events/stream at a time, however
// many components want live events.
export function ActivityFeed({ boardId }: { boardId: string | null }) {
  const { events } = useNotifications();

  return (
    <div className="flex w-[290px] shrink-0 flex-col border-l border-border">
      <div className="flex shrink-0 items-center justify-between px-4 pb-2.5 pt-3.5">
        <div className="text-[12.5px] font-bold uppercase tracking-wide text-muted-foreground">Activity</div>
        {boardId && (
          <Link href={`/board/${boardId}/graph`} className="text-[11.5px] font-semibold text-primary hover:underline">
            Dependency graph →
          </Link>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {!boardId || events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {events.map((event) => (
              <li key={event.id} className="border-l-2 border-border pl-2.5">
                <div className="text-xs leading-relaxed text-foreground">
                  {event.entityType === "card" ? (
                    <Link href={`/card/${event.entityId}`} className="hover:underline">
                      {describeEvent(event)}
                    </Link>
                  ) : (
                    describeEvent(event)
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
