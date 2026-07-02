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
    <div className="min-w-[260px] flex-[0_0_280px] rounded-lg bg-muted p-2.5">
      <div className="mb-2 text-xs font-bold uppercase text-muted-foreground">Activity</div>
      {!boardId || events.length === 0 ? (
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="m-0 list-none p-0 text-xs">
          {events.map((event) => (
            <li key={event.id} className="mb-1.5">
              <span className="text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>{" "}
              {event.entityType === "card" ? (
                <Link href={`/card/${event.entityId}`} className="text-primary hover:underline">
                  {describeEvent(event)}
                </Link>
              ) : (
                describeEvent(event)
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
