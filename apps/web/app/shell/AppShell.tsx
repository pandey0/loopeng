"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

// Every page in the source design (Board, Docs List, Doc Detail, New ADR,
// Card Detail, Dependency Graph, Activity, Inbox, Project Picker, Settings)
// uses the same dark palette -- this is an app-wide theme, not a per-route
// one. <main> is unconditionally dark and unpadded/full-bleed; each page owns
// its own internal scroll region and padding/max-width (matching the design,
// where every page manages its own centered content column), same pattern
// the board page already uses for its internal column scrolling.
//
// Sidebar/TopBar are the *current project's* nav (Board/Docs/Activity/Inbox
// all implicitly operate on whichever board is selected, and the board
// switcher + "New project"/pause-agents controls only make sense once
// you're inside one). /projects (picking a project) and /settings
// (workspace-wide, not project-scoped) are meant to stand alone -- Settings
// already ships its own header/breadcrumb for exactly this reason, so
// wrapping it in the project shell too was pure double-chrome, not a
// deliberate choice.
const STANDALONE_ROUTES = ["/projects", "/settings"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const standalone = STANDALONE_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));

  if (standalone) {
    return <div className="theme-dark h-screen overflow-hidden bg-background text-foreground">{children}</div>;
  }

  return (
    <div className="theme-dark flex h-screen text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">{children}</main>
      </div>
    </div>
  );
}
