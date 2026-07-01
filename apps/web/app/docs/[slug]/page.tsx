"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DocViewer } from "@loopeng/ui";
import { api } from "../../../lib/api";

export default function DocDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const docQuery = useQuery({ queryKey: ["doc", slug], queryFn: () => api.getDoc(slug) });
  const versionsQuery = useQuery({ queryKey: ["doc-versions", slug], queryFn: () => api.getDocVersions(slug) });

  if (docQuery.isLoading) return <p>Loading...</p>;
  if (!docQuery.data) return <p>Not found.</p>;

  const doc = docQuery.data;
  return (
    <DocViewer
      title={doc.title}
      status={doc.status}
      tags={doc.tags}
      body={doc.body}
      versions={versionsQuery.data ?? []}
    />
  );
}
