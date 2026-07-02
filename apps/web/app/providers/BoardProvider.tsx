"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Board } from "@loopeng/shared";
import { api } from "../../lib/api";

const STORAGE_KEY = "loopeng.selectedBoardId";

interface BoardContextValue {
  boardId: string | null;
  setBoardId: (boardId: string) => void;
  boards: Board[];
  boardsLoading: boolean;
}

const BoardContext = createContext<BoardContextValue | null>(null);

// Holds the app's single "current board" selection so the top bar's board
// switcher can drive it from any page, not just /board — every consumer
// (board page, notification stream scope, dependency graph) reads the same
// value instead of each page re-deriving its own.
export function BoardProvider({ children }: { children: ReactNode }) {
  const boardsQuery = useQuery({ queryKey: ["boards"], queryFn: api.listBoards });
  const [boardId, setBoardIdState] = useState<string | null>(null);

  useEffect(() => {
    if (boardId || !boardsQuery.data || boardsQuery.data.length === 0) return;
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    const initial = stored && boardsQuery.data.some((b) => b.id === stored) ? stored : boardsQuery.data[0]!.id;
    setBoardIdState(initial);
  }, [boardId, boardsQuery.data]);

  function setBoardId(next: string) {
    setBoardIdState(next);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next);
  }

  const value = useMemo(
    () => ({ boardId, setBoardId, boards: boardsQuery.data ?? [], boardsLoading: boardsQuery.isLoading }),
    [boardId, boardsQuery.data, boardsQuery.isLoading],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used within a BoardProvider");
  return ctx;
}
