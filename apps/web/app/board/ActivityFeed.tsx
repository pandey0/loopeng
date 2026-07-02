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
    <div style={{ minWidth: 260, flex: "0 0 280px", background: "#f7fafc", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#4a5568", marginBottom: 8 }}>
        Activity
      </div>
      {events.length === 0 ? (
        <p style={{ fontSize: 12, color: "#718096" }}>No activity yet.</p>
      ) : (
        <ul style={{ fontSize: 12, listStyle: "none", padding: 0, margin: 0 }}>
          {events.map((event) => (
            <li key={event.id} style={{ marginBottom: 6 }}>
              <span style={{ color: "#718096" }}>{new Date(event.createdAt).toLocaleTimeString()}</span>{" "}
              {event.entityType === "card" ? (
                <Link href={`/card/${event.entityId}`}>{describeEvent(event)}</Link>
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
