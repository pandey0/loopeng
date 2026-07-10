"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, NotificationBell, type NotificationItem } from "@loopeng/ui";
import { useNotifications } from "../providers/NotificationProvider";
import { useBoard } from "../providers/BoardProvider";
import { describeEvent } from "../../lib/events";
import { BoardSwitcher } from "./BoardSwitcher";
import { IntakeModal } from "./IntakeModal";
import { NewProjectModal } from "./NewProjectModal";

export function TopBar() {
  const { events, unreadCount, markAllRead } = useNotifications();
  const { boardId } = useBoard();
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // Local-only per the design's pause/resume-all-agents control -- there's no
  // backend concept of pausing every agent run, no API for it. Kept as a
  // visual affordance, not wired to anything real.
  const [agentsPaused, setAgentsPaused] = useState(false);

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
        <button
          type="button"
          title="Not connected to anything yet -- visual preview only"
          onClick={() => setAgentsPaused((p) => !p)}
          className={
            agentsPaused
              ? "flex items-center gap-2 rounded-md border border-warning bg-warning px-3.5 py-2 text-sm font-semibold text-warning-foreground"
              : "flex items-center gap-2 rounded-md border border-input bg-transparent px-3.5 py-2 text-sm font-semibold text-muted-foreground hover:bg-accent"
          }
        >
          <span>{agentsPaused ? "▶" : "⏸"}</span>
          {agentsPaused ? "Resume agents" : "Pause all agents"}
        </button>
        <Button size="sm" variant="outline" onClick={() => setNewProjectOpen(true)}>
          New project
        </Button>
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
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </header>
  );
}
