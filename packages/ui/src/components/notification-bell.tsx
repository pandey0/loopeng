"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export interface NotificationItem {
  id: string | number;
  title: string;
  description?: string;
  createdAt: string;
  read: boolean;
  href?: string;
}

export interface NotificationBellProps {
  items: NotificationItem[];
  unreadCount: number;
  /** Called when the panel is opened, so callers can mark everything read. */
  onOpen?: () => void;
  onItemClick?: (item: NotificationItem) => void;
  renderItemLink?: (item: NotificationItem, children: React.ReactNode) => React.ReactNode;
}

function BellIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S5 12 5 8Z" />
      <path d="M8.2 16a1.8 1.8 0 0 0 3.6 0" />
    </svg>
  );
}

export function NotificationBell({ items, unreadCount, onOpen, onItemClick, renderItemLink }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpen?.();
      return next;
    });
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={toggle}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 max-h-[420px] w-[340px] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg">
          <div className="border-b px-3 py-2 text-xs font-bold uppercase text-muted-foreground">Notifications</div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No notifications yet.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((item) => {
                const content = (
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        item.read ? "bg-transparent" : "bg-primary",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{item.title}</div>
                      {item.description && <div className="text-[11px] text-muted-foreground">{item.description}</div>}
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {new Date(item.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                );
                return (
                  <li key={item.id} className="border-b px-3 py-2 last:border-b-0 hover:bg-accent" onClick={() => onItemClick?.(item)}>
                    {renderItemLink ? renderItemLink(item, content) : content}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
