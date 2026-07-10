"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

// Sidebar + TopBar are always the dark Board.dc.html chrome; the board page's
// own content opts into the same .theme-dark scope (see globals.css), while
// every other route (/docs, /activity, /card/[cardId]) keeps today's light
// theme inside <main> untouched.
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isBoard = pathname?.startsWith("/board") ?? false;

  return (
    <div className="flex h-screen">
      <div className="theme-dark flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="theme-dark flex-shrink-0">
          <TopBar />
        </div>
        <main
          className={
            isBoard
              ? "theme-dark flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
              : "flex-1 overflow-y-auto bg-background p-5 text-foreground"
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
