"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityEvent } from "../../lib/api";

function describeEvent(event: ActivityEvent): string {
  if (event.eventType === "card.moved") {
    const { from, to } = event.payload as { from?: string; to?: string };
    return `moved ${from ?? "?"} → ${to ?? "?"}`;
  }
  if (event.eventType === "card.awaiting_deploy") return "awaiting deploy";
  if (event.eventType === "doc.drift_detected") return "doc drift detected";
  return event.eventType;
}

export function ActivityFeed({ boardId }: { boardId: string | null }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  const eventsQuery = useQuery({
    queryKey: ["events", boardId],
    queryFn: () => api.listEvents({ boardId: boardId ?? undefined, limit: 50 }),
    enabled: !!boardId,
  });

  useEffect(() => {
    setEvents(eventsQuery.data ?? []);
  }, [eventsQuery.data]);

  useEffect(() => {
    if (!boardId) return;
    const source = new EventSource(api.eventsStreamUrl(boardId));
    source.addEventListener("activity", (raw) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as ActivityEvent;
      setEvents((prev) => (prev.some((existing) => existing.id === event.id) ? prev : [event, ...prev].slice(0, 50)));
      if (event.eventType.startsWith("card.")) {
        queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
      }
    });
    return () => source.close();
  }, [boardId, queryClient]);

  return (
    <div className="min-w-[260px] flex-[0_0_280px] rounded-lg bg-muted p-2.5">
      <div className="mb-2 text-xs font-bold uppercase text-muted-foreground">Activity</div>
      {events.length === 0 ? (
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
