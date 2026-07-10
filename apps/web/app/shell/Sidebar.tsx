"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@loopeng/ui";
import { useNotifications } from "../providers/NotificationProvider";

const NAV_ITEMS = [
  { href: "/board", label: "Board", icon: "🗂️" },
  { href: "/docs", label: "Docs", icon: "📄" },
  { href: "/activity", label: "Activity", icon: "📶" },
] as const;

function NavRow({
  href,
  icon,
  label,
  active,
  badge,
  disabled,
}: {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  badge?: number;
  disabled?: boolean;
}) {
  const content = (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-md border-l-2 px-2.5 py-2 text-sm font-semibold transition-colors",
        active ? "border-primary bg-primary/10 text-foreground" : "border-transparent text-muted-foreground",
        !disabled && !active && "hover:bg-accent hover:text-accent-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="w-[18px] text-center text-[15px]">{icon}</span>
      <span className="flex-1">{label}</span>
      {!!badge && badge > 0 && (
        <span className="rounded-full bg-destructive px-1.5 py-0.5 font-mono text-[10px] font-bold text-destructive-foreground">{badge}</span>
      )}
    </div>
  );

  if (disabled) return content;
  return (
    <Link href={href} className="no-underline">
      {content}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { unreadCount } = useNotifications();

  return (
    <aside className="flex h-full w-[200px] shrink-0 flex-col bg-background px-3 py-4">
      <Link href="/board" className="mb-1.5 flex items-center gap-2.5 border-b border-border px-1.5 pb-4 no-underline">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary/80 font-mono text-[13px] font-bold text-primary-foreground">
          L
        </div>
        <div className="text-[14.5px] font-bold text-foreground">LoopEng</div>
      </Link>

      <nav className="mt-3.5 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <NavRow
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
          />
        ))}
        {/* Inbox and Settings aren't built yet -- shown per the design for
            visual completeness but intentionally not wired to a route. The
            unread badge reuses the real notification count as a preview of
            what Inbox would show, it isn't a separate inbox data source. */}
        <NavRow href="#" icon="📥" label="Inbox" active={false} badge={unreadCount} disabled />
      </nav>

      <div className="flex-1" />

      <NavRow href="#" icon="⚙️" label="Settings" active={false} disabled />
    </aside>
  );
}
