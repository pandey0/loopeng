"use client";

import { use } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DocViewer } from "@loopeng/ui";
import { api } from "../../../lib/api";

export default function DocDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const queryClient = useQueryClient();
  const docQuery = useQuery({ queryKey: ["doc", slug], queryFn: () => api.getDoc(slug) });
  const versionsQuery = useQuery({ queryKey: ["doc-versions", slug], queryFn: () => api.getDocVersions(slug) });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptDoc(slug, docQuery.data!.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["doc", slug] });
      queryClient.invalidateQueries({ queryKey: ["doc-versions", slug] });
    },
  });

  return (
    // Page owns its own scroll region + padding (AppShell's <main> is
    // unpadded and overflow-hidden by design) -- without this, long docs
    // (body + version history) were clipped with no way to reach the rest.
    <div className="flex-1 overflow-y-auto px-8 pb-[60px] pt-7">
      <Link href="/docs" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← Back to docs
      </Link>
      {docQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : !docQuery.data ? (
        <p className="text-sm text-muted-foreground">Not found.</p>
      ) : (
        <DocViewer
          title={docQuery.data.title}
          status={docQuery.data.status}
          tags={docQuery.data.tags}
          body={docQuery.data.body}
          versions={versionsQuery.data ?? []}
          onAccept={() => acceptMutation.mutate()}
          accepting={acceptMutation.isPending}
        />
      )}
    </div>
  );
}
