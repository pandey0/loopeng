"use client";

import Link from "next/link";
import { NotificationBell, type NotificationItem } from "@loopeng/ui";
import { useNotifications } from "../providers/NotificationProvider";
import { describeEvent } from "../../lib/events";
import { BoardSwitcher } from "./BoardSwitcher";

export function TopBar() {
  const { events, unreadCount, markAllRead } = useNotifications();

  const items: NotificationItem[] = events.map((event) => ({
    id: event.id,
    title: describeEvent(event),
    description: event.entityType,
    createdAt: event.createdAt,
    read: event.read,
    href: event.entityType === "card" ? `/card/${event.entityId}` : undefined,
  }));

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-4">
      <BoardSwitcher />
      <NotificationBell
        items={items}
        unreadCount={unreadCount}
        onOpen={markAllRead}
        renderItemLink={(item, children) =>
          item.href ? (
            <Link href={item.href} className="block">
              {children}
            </Link>
          ) : (
            children
          )
        }
      />
    </header>
  );
}
