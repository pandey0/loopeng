import type { ReactNode } from "react";
import Link from "next/link";
import { QueryProvider } from "./providers/QueryProvider";
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
          <nav className="flex items-center gap-5 border-b px-5 py-3 text-sm">
            <strong>LoopEng</strong>
            <Link href="/board" className="text-muted-foreground hover:text-foreground">
              Board
            </Link>
            <Link href="/docs" className="text-muted-foreground hover:text-foreground">
              Docs
            </Link>
          </nav>
          <main className="p-5">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
