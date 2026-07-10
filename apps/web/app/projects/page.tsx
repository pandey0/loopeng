"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@loopeng/ui";
import { api } from "../../lib/api";
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
// that exists on the real `Project` type (id, name, repoPath, createdAt --
// see packages/shared/src/schemas.ts) or anywhere in the backend, so it's
// omitted entirely rather than faked. Only real fields are rendered.
export default function ProjectsPage() {
  const router = useRouter();
  const { setBoardId } = useBoard();
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const boardsQuery = useQuery({ queryKey: ["boards"], queryFn: api.listBoards });

  const projects = projectsQuery.data ?? [];
  const boards = boardsQuery.data ?? [];
  const loading = projectsQuery.isLoading || boardsQuery.isLoading;

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
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{project.repoPath}</div>
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
    </div>
  );
}
