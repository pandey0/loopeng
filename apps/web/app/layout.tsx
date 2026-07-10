import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { ToastProvider } from "@loopeng/ui";
import { QueryProvider } from "./providers/QueryProvider";
import { BoardProvider } from "./providers/BoardProvider";
import { NotificationProvider } from "./providers/NotificationProvider";
import { AppShell } from "./shell/AppShell";
import "./globals.css";

// Every page in the source design uses `font-family:'Space Grotesk',sans-serif`
// as its base typeface and JetBrains Mono for anything mono-tagged (badges,
// timestamps, code) -- this is app-wide now that AppShell makes the whole app
// dark (see globals.css), not scoped to one route.
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: "LoopEng",
  description: "Docs + Kanban + loop-engineered agent dev cycle",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="m-0 font-display text-foreground antialiased">
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
