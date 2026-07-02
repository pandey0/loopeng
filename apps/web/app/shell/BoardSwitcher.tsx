"use client";

import { usePathname, useRouter } from "next/navigation";
import { useBoard } from "../providers/BoardProvider";

const GRAPH_ROUTE = /^\/board\/([^/]+)\/graph$/;

// Lives in the top bar so it's reachable from every page, not just /board —
// changing it updates the shared BoardProvider context that the board page,
// the notification stream scope, and this switcher itself all read from.
export function BoardSwitcher() {
  const { boardId, setBoardId, boards, boardsLoading } = useBoard();
  const pathname = usePathname();
  const router = useRouter();

  if (boardsLoading) return <span className="text-sm text-muted-foreground">Loading boards…</span>;
  if (boards.length === 0) return <span className="text-sm text-muted-foreground">No boards yet</span>;

  function handleChange(next: string) {
    setBoardId(next);
    const graphMatch = pathname.match(GRAPH_ROUTE);
    if (graphMatch) router.push(`/board/${next}/graph`);
  }

  return (
    <select
      value={boardId ?? ""}
      onChange={(e) => handleChange(e.target.value)}
      aria-label="Switch board"
      className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
    >
      {boards.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
