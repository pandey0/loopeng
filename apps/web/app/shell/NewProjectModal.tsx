"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button, cn, Dialog, Input, Label } from "@loopeng/ui";
import { api, ApiError } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
}

type Source = "local" | "clone";

// Registering a project is a repo-path onboarding step, not a code-editing
// one — so this stays a plain form + POST, no agent run / streaming panel
// like /plan's intake flow. The path/URL is validated server-side (see POST
// /projects) so a typo, a not-yet-a-git-repo directory, or an unreachable
// clone URL fails right here with a specific message instead of leaving a
// card silently stuck later. Either source ends the same way: as soon as
// the project+board exist, the server kicks off the analyzer agent in the
// background to build the project's brief — the "brain" every later agent
// on this project gets handed automatically. That run isn't awaited here;
// its progress shows up on /projects once this modal closes.
export function NewProjectModal({ open, onClose }: NewProjectModalProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { setBoardId } = useBoard();
  const [source, setSource] = useState<Source>("local");
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceValue = source === "local" ? repoPath : repoUrl;
  const canSubmit = !!name.trim() && !!sourceValue.trim() && !submitting;

  function reset() {
    setSource("local");
    setName("");
    setRepoPath("");
    setRepoUrl("");
    setSubmitting(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { board } = await api.createProject(
        source === "local"
          ? { name: name.trim(), repoPath: repoPath.trim() }
          : { name: name.trim(), repoUrl: repoUrl.trim() },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["boards"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      setBoardId(board.id);
      handleClose();
      router.push("/board");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="New project"
      description="Register another repo for this platform to work on. It gets its own board, worktrees, and deploys, isolated from every other project."
    >
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Storefront API"
          />
        </div>

        <div className="flex rounded-md border border-input bg-secondary/50 p-0.5 text-sm">
          {(["local", "clone"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={cn(
                "flex-1 rounded-[5px] py-1.5 font-medium transition-colors",
                source === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "local" ? "Local path" : "Clone from GitHub"}
            </button>
          ))}
        </div>

        {source === "local" ? (
          <div>
            <Label htmlFor="project-repo-path">Repo path</Label>
            <Input
              id="project-repo-path"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
            />
            <p className="mt-1 text-xs text-muted-foreground">A directory already on this machine, containing a .git folder.</p>
          </div>
        ) : (
          <div>
            <Label htmlFor="project-repo-url">Repository URL</Label>
            <Input
              id="project-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Cloned into a managed directory on the server before anything else runs.
            </p>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (source === "clone" ? "Cloning…" : "Registering…") : "Register project"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
