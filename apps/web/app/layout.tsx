import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { ToastProvider } from "@loopeng/ui";
import { QueryProvider } from "./providers/QueryProvider";
import { BoardProvider } from "./providers/BoardProvider";
import { NotificationProvider } from "./providers/NotificationProvider";
import { AppShell } from "./shell/AppShell";
import "./globals.css";

// Only feed the .theme-dark surfaces (board + shell chrome, see globals.css) —
// exposed as CSS vars on <html> so they're available everywhere, but body
// keeps font-sans by default so untouched pages (docs/activity/card detail)
// don't shift typeface.
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: "LoopEng",
  description: "Docs + Kanban + loop-engineered agent dev cycle",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="m-0 font-sans text-foreground antialiased">
        <QueryProvider>
          <ToastProvider>
            <BoardProvider>
              <NotificationProvider>
                <AppShell>{children}</AppShell>
              </NotificationProvider>
            </BoardProvider>
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
