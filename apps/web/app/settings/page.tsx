"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@loopeng/ui";
import { api } from "../../lib/api";

// GitHub here is a workspace-wide env var token (packages/connectors/src/github.ts
// reads GITHUB_TOKEN/GITHUB_REPO directly) -- there's no OAuth App registered
// anywhere, so there's nothing for a "Connect" button in the browser to do.
// Claude Code isn't a connection to grant either: every agent role shells out to
// the real `claude` CLI directly (packages/agents/src/claude-cli.ts), so
// "connected" just means the api process can see a working CLI. Both cards below
// show the real status from GET /connections and, when disconnected, how to fix
// it -- not a fake Connect button pretending to do something the browser can't.
interface ConnectionCardProps {
  icon: ReactNode;
  iconClassName: string;
  title: string;
  description: string;
  connected: boolean;
  detail: string;
  fixInstructions: ReactNode;
}

function ConnectionCard({ icon, iconClassName, title, description, connected, detail, fixInstructions }: ConnectionCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg", iconClassName)}>{icon}</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            connected ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground")} />
          {connected ? "connected" : "not connected"}
        </span>
      </div>

      <div className="mt-4 border-t border-border pt-4 pl-[52px] text-xs text-muted-foreground">
        {connected ? detail : fixInstructions}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.getConnections(),
    refetchOnWindowFocus: false,
  });

  const githubConnected = !!data?.github.connected;
  const claudeConnected = !!data?.claude.connected;
  const bothConnected = githubConnected && claudeConnected;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex items-center gap-2">
          <Link href="/projects" className="font-display text-base font-bold text-foreground hover:text-primary">
            LoopEng
          </Link>
          <span className="text-sm text-muted-foreground">/ Settings</span>
        </div>
        <Link href="/board" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to board
        </Link>
      </header>

      <div className="mx-auto w-full max-w-[680px] px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground">Connections</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Workspace-wide, server-side configuration — not something granted per-session from the browser. Each
              card below reflects the api server&apos;s actual current environment.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="shrink-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-50"
          >
            {isFetching ? "Checking…" : "Refresh"}
          </button>
        </div>

        <div className="mt-7 text-[12.5px] font-bold uppercase tracking-[0.04em] text-muted-foreground">
          Connections
        </div>

        {isLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">Checking connections…</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3.5">
            <ConnectionCard
              icon="🐙"
              iconClassName="bg-secondary"
              title="GitHub"
              description="Lets agents clone repos, push branches, and open pull requests."
              connected={githubConnected}
              detail={`repo: ${data?.github.repo ?? "?"}`}
              fixInstructions={
                <>
                  Set <code className="rounded bg-secondary px-1 py-0.5 font-mono">GITHUB_TOKEN</code> and{" "}
                  <code className="rounded bg-secondary px-1 py-0.5 font-mono">GITHUB_REPO</code> in the api
                  process&apos;s environment, then restart it. There&apos;s no OAuth app registered for this
                  workspace — this is a single server-side token, not a per-user grant.
                </>
              }
            />
            <ConnectionCard
              icon="C"
              iconClassName="bg-gradient-to-br from-primary to-primary/80 font-display font-bold text-primary-foreground"
              title="Claude Code CLI"
              description="Runs the planner, implementer, reviewer, and designer agents on every card."
              connected={claudeConnected}
              detail={data?.claude.version ?? ""}
              fixInstructions={
                <>
                  The api process couldn&apos;t run <code className="rounded bg-secondary px-1 py-0.5 font-mono">claude --version</code>.
                  Install the Claude Code CLI and make sure it&apos;s on the PATH of whatever process runs apps/api.
                </>
              }
            />
          </div>
        )}

        {!isLoading &&
          (bothConnected ? (
            <div className="mt-6 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
              ✓ Set up. Agents can work across every project in this workspace.
            </div>
          ) : (
            <div className="mt-6 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
              ⚠ Both GitHub and the Claude Code CLI need to be configured on the server before cards can be promoted
              to Ready — agents can&apos;t start work without them.
            </div>
          ))}
      </div>
    </div>
  );
}
