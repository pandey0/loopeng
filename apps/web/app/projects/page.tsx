"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@loopeng/shared";
import { Button, Dialog } from "@loopeng/ui";
import { api } from "../../lib/api";
import { AgentSessionPanel } from "../card/[cardId]/AgentSessionPanel";
import { useBoard } from "../providers/BoardProvider";
import { NewProjectModal } from "../shell/NewProjectModal";

// `Project`/`Board.createdAt` are typed `Date` by the shared zod schemas
// (z.coerce.date()), but api.ts's `request()` is a bare `res.json()` with no
// schema parsing -- over the wire it's really an ISO string. Guard both
// shapes here instead of trusting the type, since `new Date(aDateInstance)`
// doesn't even typecheck (Date isn't assignable to the string|number
// constructor overload).
function formatCreatedAt(value: Date): string {
  const date = value instanceof Date ? value : new Date(value as unknown as string);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// The Project Picker mockup this ports also shows fake per-project git
// status ("clean" / "CI failing" / "3 ahead", merge-conflict counts, a
// cloning progress bar, "opened 2h ago" live-session timestamps). None of
// that exists anywhere in the backend, so it's omitted rather than faked.
// briefStatus is real though (POST /projects kicks off the analyzer agent
// in the background) -- polled below so "Building brain…" flips to "Brain
// ready" without a manual refresh.
//
// This is a snapshot, not something that stays in sync with the repo --
// nothing re-runs it as cards land, so the reanalyze button is the only
// way to refresh it, not a cosmetic extra.
function BriefBadge({ project, onWatch, onReanalyze }: { project: Project; onWatch: () => void; onReanalyze: () => void }) {
  if (project.briefStatus === "ready" || project.briefStatus === "failed") {
    const ready = project.briefStatus === "ready";
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        {ready ? (
          <Link
            href={`/docs/project-brief-${project.id}`}
            className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success hover:underline"
          >
            🧠 Brain ready
          </Link>
        ) : (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
            Brain analysis failed
          </span>
        )}
        <button
          type="button"
          onClick={onReanalyze}
          title="Re-run analysis (the brief doesn't update on its own as the repo changes)"
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          ↻ Re-analyze
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onWatch}
      className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
    >
      Building brain… (watch)
    </button>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setBoardId } = useBoard();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [watchingProjectId, setWatchingProjectId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    refetchInterval: (query) => {
      const data = query.state.data as Project[] | undefined;
      const anyAnalyzing = data?.some((p) => p.briefStatus === "pending" || p.briefStatus === "analyzing");
      return anyAnalyzing ? 3000 : false;
    },
  });
  const boardsQuery = useQuery({ queryKey: ["boards"], queryFn: api.listBoards });

  const analyzerRunQuery = useQuery({
    queryKey: ["project-analyzer-run", watchingProjectId],
    queryFn: () => api.getProjectAnalyzerRun(watchingProjectId!),
    enabled: !!watchingProjectId,
  });

  const reanalyzeMutation = useMutation({
    mutationFn: (projectId: string) => api.reanalyzeProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const projects = projectsQuery.data ?? [];
  const boards = boardsQuery.data ?? [];
  const loading = projectsQuery.isLoading || boardsQuery.isLoading;
  const watchingProject = projects.find((p) => p.id === watchingProjectId) ?? null;

  function handleOpen(projectId: string) {
    const board = boards.find((b) => b.projectId === projectId);
    if (board) setBoardId(board.id);
    router.push("/board");
  }

  const cloneButtonClasses =
    "w-full rounded-lg border border-dashed border-border py-3.5 text-[13.5px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-foreground";

  return (
    <div className="mx-auto w-full max-w-[1080px] overflow-y-auto px-6 py-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Projects</h1>
        <Link
          href="/settings"
          className="rounded-lg border border-border bg-card px-3.5 py-[7px] text-[13px] font-semibold text-foreground/90 hover:text-foreground"
        >
          ⚙️ Settings
        </Link>
      </div>
      <p className="mb-11 text-sm text-muted-foreground">
        Autonomous dev, human checkpoints. Open a project to pick up where the agents left off.
      </p>

      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-foreground">Recent projects</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {projects.length} {projects.length === 1 ? "workspace" : "workspaces"}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      ) : projectsQuery.isError || boardsQuery.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load projects. Try refreshing.</p>
      ) : projects.length === 0 ? (
        <div className="mb-6">
          <p className="mb-4 text-center text-sm text-muted-foreground">No projects yet. Register a repo to get started.</p>
          <button type="button" onClick={() => setNewProjectOpen(true)} className={cloneButtonClasses}>
            + Clone repository
          </button>
        </div>
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-lg">
                  📁
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="truncate text-sm font-bold text-foreground">{project.name}</div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      created {formatCreatedAt(project.createdAt)}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {project.repoUrl ? `${project.repoUrl} → ${project.repoPath}` : project.repoPath}
                    </div>
                    <BriefBadge
                      project={project}
                      onWatch={() => setWatchingProjectId(project.id)}
                      onReanalyze={() => reanalyzeMutation.mutate(project.id)}
                    />
                  </div>
                </div>
              </div>
              <Button onClick={() => handleOpen(project.id)}>Open</Button>
            </li>
          ))}
        </ul>
      )}

      {projects.length > 0 && (
        <button type="button" onClick={() => setNewProjectOpen(true)} className={cloneButtonClasses}>
          + Clone repository
        </button>
      )}

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />

      <Dialog
        open={!!watchingProjectId}
        onClose={() => setWatchingProjectId(null)}
        title={`Building brain — ${watchingProject?.name ?? ""}`}
        description="The analyzer agent exploring this repo, live."
      >
        {analyzerRunQuery.data ? (
          <AgentSessionPanel
            agentRunId={analyzerRunQuery.data.id}
            roleName="analyzer"
            live={analyzerRunQuery.data.status === "running"}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {analyzerRunQuery.isLoading ? "Loading…" : "No run recorded for this project yet."}
          </p>
        )}
      </Dialog>
    </div>
  );
}
