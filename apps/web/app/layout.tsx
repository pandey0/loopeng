import type { ReactNode } from "react";
import Link from "next/link";
import { QueryProvider } from "./providers/QueryProvider";

export const metadata = {
  title: "LoopEng",
  description: "Docs + Kanban + loop-engineered agent dev cycle",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#1a202c" }}>
        <QueryProvider>
          <nav
            style={{
              display: "flex",
              gap: 20,
              padding: "12px 20px",
              borderBottom: "1px solid #e2e8f0",
              fontSize: 14,
            }}
          >
            <strong>LoopEng</strong>
            <Link href="/board">Board</Link>
            <Link href="/docs">Docs</Link>
          </nav>
          <main style={{ padding: 20 }}>{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
