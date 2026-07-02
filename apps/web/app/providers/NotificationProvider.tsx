"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@loopeng/ui";
import { api, type ActivityEvent } from "../../lib/api";
import { describeEvent, toHighSignalToast } from "../../lib/events";
import { useBoard } from "./BoardProvider";

const MAX_EVENTS = 50;

export interface NotificationEvent extends ActivityEvent {
  read: boolean;
}

interface NotificationContextValue {
  events: NotificationEvent[];
  unreadCount: number;
  markAllRead: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

// Single owner of the GET /events/stream connection for the whole app. It
// mounts once at the app root (see layout.tsx) and fans out every event to:
// React Query cache invalidation (so the board + card detail pages update
// live), toasts for high-signal transitions, and the notification bell's
// unread list. Every other component (ActivityFeed, the bell) reads from
// this context instead of opening its own EventSource.
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { boardId } = useBoard();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const seenIds = useRef<Set<number>>(new Set());

  const initialEventsQuery = useQuery({
    queryKey: ["events", boardId],
    queryFn: () => api.listEvents({ boardId: boardId ?? undefined, limit: MAX_EVENTS }),
    enabled: !!boardId,
  });

  useEffect(() => {
    if (!initialEventsQuery.data) return;
    seenIds.current = new Set(initialEventsQuery.data.map((e) => e.id));
    setEvents(initialEventsQuery.data.map((e) => ({ ...e, read: true })));
  }, [initialEventsQuery.data]);

  useEffect(() => {
    if (!boardId) return;
    const source = new EventSource(api.eventsStreamUrl(boardId));

    source.addEventListener("activity", (raw) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as ActivityEvent;
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);

      setEvents((prev) => [{ ...event, read: false }, ...prev].slice(0, MAX_EVENTS));

      if (event.entityType === "card") {
        queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
        queryClient.invalidateQueries({ queryKey: ["card-detail", event.entityId] });
      }

      const toast = toHighSignalToast(event);
      if (toast) pushToast(toast);
    });

    return () => source.close();
  }, [boardId, queryClient, pushToast]);

  function markAllRead() {
    setEvents((prev) => prev.map((e) => (e.read ? e : { ...e, read: true })));
  }

  const unreadCount = useMemo(() => events.filter((e) => !e.read).length, [events]);

  const value = useMemo(() => ({ events, unreadCount, markAllRead }), [events, unreadCount]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationProvider");
  return ctx;
}

export { describeEvent };
