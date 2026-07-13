"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "@loopeng/ui";
import type { GateResultStatus } from "@loopeng/shared";
import { api } from "../../lib/api";

function failureReason(detail: Record<string, unknown>): string | null {
  if (typeof detail.reason === "string") return detail.reason;
  if (detail.deployFailure && typeof detail.deployFailure === "object") {
    const nested = (detail.deployFailure as Record<string, unknown>).reason;
    if (typeof nested === "string") return nested;
  }
  return Object.keys(detail).length > 0 ? JSON.stringify(detail) : null;
}

export default function HealthPage() {
  const deploysQuery = useQuery({
    queryKey: ["deploys"],
    queryFn: () => api.listDeploys(),
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-[60px] pt-7">
      <div className="mx-auto max-w-[900px]">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-xl font-bold text-foreground">Health</h1>
          <button
            type="button"
            onClick={() => deploysQuery.refetch()}
            disabled={deploysQuery.isFetching}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-50"
          >
            {deploysQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p className="mb-6 text-[13px] text-muted-foreground">Most recent deploy attempts, newest first.</p>

        {deploysQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : deploysQuery.isError ? (
          <p className="text-sm text-destructive">
            Failed to load deploy status: {(deploysQuery.error as Error).message}
          </p>
        ) : deploysQuery.data && deploysQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deploys yet.</p>
        ) : (
          <ul className="m-0 list-none space-y-1.5 p-0">
            {deploysQuery.data?.map((deploy) => {
              const reason = deploy.status === "failed" ? failureReason(deploy.detail) : null;
              return (
                <li key={deploy.id} className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={deploy.status as GateResultStatus} className="rounded font-mono font-bold" />
                    <Link href={`/card/${deploy.card.id}`} className="flex-1 truncate text-[13.5px] font-semibold text-foreground hover:underline">
                      {deploy.card.title}
                    </Link>
                    {deploy.board && <span className="text-xs text-muted-foreground">{deploy.board.name}</span>}
                    <span className="font-mono text-[11px] text-muted-foreground">{new Date(deploy.createdAt).toLocaleString()}</span>
                  </div>
                  {reason && <p className="mt-2 text-xs text-destructive">{reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
