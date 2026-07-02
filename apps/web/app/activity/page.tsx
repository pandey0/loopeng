"use client";

import Link from "next/link";
import { useBoard } from "../providers/BoardProvider";
import { useNotifications } from "../providers/NotificationProvider";
import { describeEvent } from "../../lib/events";

export default function ActivityPage() {
  const { boardId, boards } = useBoard();
  const { events } = useNotifications();
  const boardName = boards.find((b) => b.id === boardId)?.name;

  return (
    <div className="max-w-[720px]">
      <h1 className="mb-1 text-2xl font-bold">Activity</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {boardName ? `Live events for ${boardName}.` : "Live events for the current board."}
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="m-0 list-none p-0 text-sm">
          {events.map((event) => (
            <li key={event.id} className="mb-2 border-b pb-2 last:border-b-0">
              <span className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span>{" "}
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
