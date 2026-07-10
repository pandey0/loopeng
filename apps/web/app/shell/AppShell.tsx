"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

// Every page in the source design (Board, Docs List, Doc Detail, New ADR,
// Card Detail, Dependency Graph, Activity, Inbox, Project Picker, Settings)
// uses the same dark palette -- this is an app-wide theme, not a per-route
// one. <main> is unconditionally dark and unpadded/full-bleed; each page owns
// its own internal scroll region and padding/max-width (matching the design,
// where every page manages its own centered content column), same pattern
// the board page already uses for its internal column scrolling.
export function AppShell({ children }: { children: ReactNode }) {
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
