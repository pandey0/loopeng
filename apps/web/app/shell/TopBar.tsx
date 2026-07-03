"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, NotificationBell, type NotificationItem } from "@loopeng/ui";
import { useNotifications } from "../providers/NotificationProvider";
import { useBoard } from "../providers/BoardProvider";
import { describeEvent } from "../../lib/events";
import { BoardSwitcher } from "./BoardSwitcher";
import { IntakeModal } from "./IntakeModal";

export function TopBar() {
  const { events, unreadCount, markAllRead } = useNotifications();
  const { boardId } = useBoard();
  const [intakeOpen, setIntakeOpen] = useState(false);

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
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!boardId} onClick={() => setIntakeOpen(true)}>
          New
        </Button>
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
      </div>
      {boardId && <IntakeModal boardId={boardId} open={intakeOpen} onClose={() => setIntakeOpen(false)} />}
    </header>
  );
}
