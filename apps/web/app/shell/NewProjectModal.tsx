"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Input, Label } from "@loopeng/ui";
import { api, ApiError } from "../../lib/api";
import { useBoard } from "../providers/BoardProvider";

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
}

// Registering a project is a repo-path onboarding step, not a code-editing
// one — so this stays a plain form + POST, no agent run / streaming panel
// like IntakeModal. The path is validated server-side (see POST /projects)
// so a typo or a not-yet-a-git-repo directory fails right here with a
// specific message instead of leaving a card silently stuck later.
export function NewProjectModal({ open, onClose }: NewProjectModalProps) {
  const queryClient = useQueryClient();
  const { setBoardId } = useBoard();
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setRepoPath("");
    setSubmitting(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!name.trim() || !repoPath.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { board } = await api.createProject({ name: name.trim(), repoPath: repoPath.trim() });
      await queryClient.invalidateQueries({ queryKey: ["boards"] });
      setBoardId(board.id);
      handleClose();
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
        <div>
          <Label htmlFor="project-repo-path">Repo path</Label>
          <Input
            id="project-repo-path"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/absolute/path/to/repo"
          />
        </div>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || !repoPath.trim() || submitting}>
            {submitting ? "Registering…" : "Register project"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
