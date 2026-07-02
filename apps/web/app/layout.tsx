import type { ReactNode } from "react";
import { ToastProvider } from "@loopeng/ui";
import { QueryProvider } from "./providers/QueryProvider";
import { BoardProvider } from "./providers/BoardProvider";
import { NotificationProvider } from "./providers/NotificationProvider";
import { AppShell } from "./shell/AppShell";
import "./globals.css";

export const metadata = {
  title: "LoopEng",
  description: "Docs + Kanban + loop-engineered agent dev cycle",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
