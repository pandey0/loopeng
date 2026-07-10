"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button, buttonVariants, cn } from "@loopeng/ui";
import type { DocStatus, DocType } from "@loopeng/shared";
import { api } from "../../lib/api";

const DOC_TYPES = ["wiki", "adr", "rfc", "skill"] as const;

// No dedicated "purple" design token exists (theme only defines
// primary/success/warning/destructive/muted) -- adr gets a one-off accent
// color since it's the only doc type that doesn't map onto an existing tone.
const DOC_TYPE_BADGE_CLASS: Record<DocType, string> = {
  adr: "bg-violet-500/15 text-violet-400",
  rfc: "bg-warning/15 text-warning",
  skill: "bg-success/15 text-success",
  wiki: "bg-secondary text-muted-foreground",
};

// Status pills share the type pill's sizing but sit on a flat card
// background with just the text tinted per status (mirrors the design's
// statusMap: accepted/active=green, proposed=amber, draft=muted gray).
const DOC_STATUS_BADGE_CLASS: Record<DocStatus, string> = {
  draft: "text-muted-foreground",
  proposed: "text-warning",
  accepted: "text-success",
  superseded: "text-muted-foreground",
  deprecated: "text-destructive",
};

// Exact 4-column grid from the Docs List mockup (Title flexes, Type/Status
// are fixed 90px, Tags gets a fixed 200px lane) -- a generic <table> can't
// reproduce these fixed column widths, so the list below is grid-based divs.
const DOC_GRID_COLS = "grid-cols-[1fr_90px_90px_200px]";

export default function DocsPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const docsQuery = useQuery({ queryKey: ["docs", filter], queryFn: () => api.listDocs(filter) });

  return (
    // Page owns its own scroll region + padding/max-width (AppShell's <main>
    // is unpadded and overflow-hidden by design) -- matches the mockup's
    // `flex:1; overflow-y:auto; padding:28px 32px 60px` outer wrapper with a
    // `max-width:920px; margin:0 auto` inner column.
    <div className="flex-1 overflow-y-auto px-8 pb-[60px] pt-7">
      <div className="mx-auto max-w-[920px]">
        <div className="mb-[22px] flex items-start justify-between">
          <div>
            <h1 className="text-[20px] font-bold text-foreground">Docs</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              ADRs, RFCs, skills, and general wiki pages for this board.
            </p>
          </div>
          <Link href="/docs/new/adr" className={buttonVariants({ size: "sm" })}>
            + New ADR
          </Link>
        </div>

        <div className="mb-5 flex gap-2">
          <Button
            variant={!filter ? "default" : "secondary"}
            className="h-auto rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
            onClick={() => setFilter(undefined)}
          >
            All
          </Button>
          {DOC_TYPES.map((t) => (
            <Button
              key={t}
              variant={filter === t ? "default" : "secondary"}
              className="h-auto rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
              onClick={() => setFilter(t)}
            >
              {t}
            </Button>
          ))}
        </div>

        {docsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        <div className="overflow-hidden rounded-[10px] border border-border">
          <div
            className={cn(
              "grid gap-3 border-b border-border bg-card px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.04em] text-muted-foreground",
              DOC_GRID_COLS,
            )}
          >
            <div>Title</div>
            <div>Type</div>
            <div>Status</div>
            <div>Tags</div>
          </div>
          {(docsQuery.data ?? []).map((doc) => (
            <div
              key={doc.id}
              className={cn("grid items-center gap-3 border-b border-border px-4 py-[13px] last:border-b-0", DOC_GRID_COLS)}
            >
              <Link
                href={`/docs/${doc.slug}`}
                className="truncate text-[13.5px] font-semibold text-foreground hover:text-primary hover:underline"
              >
                {doc.title}
              </Link>
              <span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase",
                    DOC_TYPE_BADGE_CLASS[doc.docType],
                  )}
                >
                  {doc.docType}
                </span>
              </span>
              <span>
                <span
                  className={cn(
                    "rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase",
                    DOC_STATUS_BADGE_CLASS[doc.status],
                  )}
                >
                  {doc.status}
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {doc.tags.map((tag) => (
                  <span key={tag} className="font-mono text-[10.5px] text-muted-foreground">
                    #{tag}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
