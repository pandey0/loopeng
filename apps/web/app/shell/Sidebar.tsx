"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@loopeng/ui";

const NAV_ITEMS = [
  { href: "/board", label: "Board" },
  { href: "/docs", label: "Docs" },
  { href: "/activity", label: "Activity" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-52 shrink-0 flex-col gap-1 border-r bg-card px-3 py-4">
      <div className="mb-4 px-2 text-sm font-bold">LoopEng</div>
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
