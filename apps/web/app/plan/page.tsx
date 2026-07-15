"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, cn, Textarea } from "@loopeng/ui";
import { ALLOWED_INTAKE_IMAGE_MIME_TYPES, type IntakeImage } from "@loopeng/shared";
import { api, ApiError } from "../../lib/api";
import { validateIntakeImageFile } from "../../lib/intakeImages";
import { AgentSessionPanel } from "../card/[cardId]/AgentSessionPanel";
import { useBoard } from "../providers/BoardProvider";

const SESSION_LIST_POLL_MS = 4000;
const STATUS_POLL_MS = 2000;

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
}

// Strips the `data:<mime>;base64,` prefix FileReader.readAsDataURL produces
// -- IntakeImageSchema's `data` field is raw base64 only.
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function statusMeta(status: string): { label: string; tone: string } {
  switch (status) {
    case "running":
      return { label: "In conversation", tone: "bg-secondary text-muted-foreground" };
    case "awaiting_approval":
      return { label: "Awaiting approval", tone: "bg-warning/15 text-warning" };
    case "succeeded":
      return { label: "Approved", tone: "bg-success/15 text-success" };
    case "failed":
      return { label: "Failed", tone: "bg-destructive/15 text-destructive" };
    default:
      return { label: status, tone: "bg-secondary text-muted-foreground" };
  }
}

// A dedicated page instead of a modal, on purpose: a planning conversation
// can run long (multiple clarifying rounds), and nothing about it should be
// lost just because you navigated away or the api restarted mid-conversation
// -- both the session list and every session's status are re-derived from
// the database on every load (see GET /boards/:id/intake[/...]), not held in
// a component that resets when closed.
function PlanPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { boardId } = useBoard();
  const queryClient = useQueryClient();

  const [requestText, setRequestText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PendingImage[]>(images);
  imagesRef.current = images;

  const selectedId = searchParams.get("session");

  // Revoke every remaining object URL on unmount -- individual removes
  // revoke their own, this only catches whatever's left when navigating away.
  // imagesRef (kept current every render) avoids the stale closure a plain
  // `[]`-dep effect would capture over `images` from the initial render.
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  function addFiles(files: FileList | File[]) {
    const accepted: PendingImage[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      const result = validateIntakeImageFile(file);
      if (!result.ok) {
        rejected.push(result.reason);
        continue;
      }
      accepted.push({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
    setImageError(rejected.length > 0 ? rejected.join("; ") : null);
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const removed = prev.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  }

  const sessionsQuery = useQuery({
    queryKey: ["intake-sessions", boardId],
    queryFn: () => api.listIntakeSessions(boardId!),
    enabled: !!boardId,
    refetchInterval: SESSION_LIST_POLL_MS,
  });

  const statusQuery = useQuery({
    queryKey: ["intake-status", boardId, selectedId],
    queryFn: () => api.getIntakeStatus(boardId!, selectedId!),
    enabled: !!boardId && !!selectedId,
    // Keep polling while the background manager review hasn't settled yet
    // (see IntakeResult.pendingManagerReview) -- it can still delete and
    // replace result.cardIds, so a caller reading this query's data needs
    // the final, post-review set before treating any card id as real.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "running") return STATUS_POLL_MS;
      if (data?.status === "succeeded" && data.result.pendingManagerReview) return STATUS_POLL_MS;
      return false;
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => api.approveIntake(boardId!, selectedId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intake-status", boardId, selectedId] });
      queryClient.invalidateQueries({ queryKey: ["intake-sessions", boardId] });
      queryClient.invalidateQueries({ queryKey: ["cards", boardId] });
    },
  });

  async function handleSubmit() {
    if (!requestText.trim() || !boardId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payloadImages: IntakeImage[] = await Promise.all(
        images.map(async (img) => ({
          mimeType: img.file.type as IntakeImage["mimeType"],
          sizeBytes: img.file.size,
          data: await readAsBase64(img.file),
        })),
      );
      const { agentRunId } = await api.intake(boardId, requestText.trim(), payloadImages);
      setRequestText("");
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      setImages([]);
      setImageError(null);
      await queryClient.invalidateQueries({ queryKey: ["intake-sessions", boardId] });
      router.push(`/plan?session=${agentRunId}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const sessions = sessionsQuery.data ?? [];
  const status = statusQuery.data;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r border-border">
        <div className="shrink-0 border-b border-border p-4">
          <h2 className="mb-2 text-sm font-bold text-foreground">New request</h2>
          <Textarea
            rows={4}
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            placeholder="Describe what you need — the planner will ask if anything's unclear"
            className="w-full text-sm"
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_INTAKE_IMAGE_MIME_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
          >
            Attach images
          </Button>

          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.id} className="relative h-12 w-12 shrink-0">
                  <img
                    src={img.previewUrl}
                    alt={img.file.name}
                    className="h-12 w-12 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${img.file.name}`}
                    onClick={() => removeImage(img.id)}
                    disabled={submitting}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-background text-muted-foreground hover:text-foreground"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {imageError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {imageError}
            </p>
          )}

          {submitError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {submitError}
            </p>
          )}
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={handleSubmit}
            disabled={!requestText.trim() || submitting || !boardId}
          >
            {submitting ? "Starting…" : "Start conversation"}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No planning sessions yet on this board.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((s) => {
                const meta = statusMeta(s.status);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/plan?session=${s.id}`)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-xs transition-colors",
                        selectedId === s.id ? "bg-accent" : "hover:bg-accent/50",
                      )}
                    >
                      <span className={cn("w-fit rounded-full px-2 py-0.5 font-medium", meta.tone)}>{meta.label}</span>
                      <span className="text-muted-foreground">{s.startedAt ? new Date(s.startedAt).toLocaleString() : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Start a new request, or pick a past session on the left.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <AgentSessionPanel
              agentRunId={selectedId}
              roleName="planner"
              live={status?.status === "running"}
              heightClassName="min-h-[280px] flex-1"
            />

            {status?.status === "awaiting_approval" && (
              <div className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 p-4">
                <h3 className="text-sm font-bold text-foreground">Proposed plan: {status.proposal.specTitle}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Will create {status.proposal.cardCount} card{status.proposal.cardCount === 1 ? "" : "s"} in backlog —
                  nothing exists on the board yet.
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {status.proposal.cards.map((c, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm"
                    >
                      <span className="flex-1 truncate">{c.title}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {c.cardType}
                      </Badge>
                      <Badge
                        variant={c.riskTier === "high" ? "destructive" : c.riskTier === "medium" ? "warning" : "success"}
                        className="text-[10px]"
                      >
                        {c.riskTier}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <Button className="mt-3" onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending}>
                  {approveMutation.isPending
                    ? "Creating…"
                    : `Approve → create ${status.proposal.cardCount} card${status.proposal.cardCount === 1 ? "" : "s"}`}
                </Button>
                {approveMutation.isError && (
                  <p className="mt-2 text-xs text-destructive">
                    {approveMutation.error instanceof ApiError
                      ? approveMutation.error.message
                      : (approveMutation.error as Error).message}
                  </p>
                )}
              </div>
            )}

            {status?.status === "succeeded" && (
              <div className="shrink-0 rounded-lg border border-success/30 bg-success/5 p-4">
                <p className="text-sm font-semibold text-success">
                  ✓ Created {status.result.cardIds.length + 1} card{status.result.cardIds.length === 0 ? "" : "s"} in backlog.
                </p>
                {status.result.pendingManagerReview ? (
                  // A manager review is still deciding whether to keep this
                  // breakdown or replace it with a different split -- see
                  // IntakeResult.pendingManagerReview. Navigating with these
                  // ids right now risks a highlight link into cards that get
                  // deleted moments later; the statusQuery above keeps
                  // polling until this clears, at which point cardIds (and
                  // this button) reflect whatever the review actually kept.
                  <p className="mt-2 text-xs text-muted-foreground">Manager is reviewing this breakdown…</p>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      router.push(`/board?highlight=${[status.result.epicCardId, ...status.result.cardIds].join(",")}`)
                    }
                  >
                    View on board
                  </Button>
                )}
              </div>
            )}

            {status?.status === "failed" && (
              <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-semibold text-destructive">Failed</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{status.error}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlanPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
      <PlanPageInner />
    </Suspense>
  );
}
