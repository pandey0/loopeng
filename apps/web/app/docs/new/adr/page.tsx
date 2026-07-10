"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AdrForm, type AdrFormValues } from "@loopeng/ui";
import { api } from "../../../../lib/api";

// doc-engine's repoRelativePath already nests by docType (adr/, rfc/, skills/),
// so the slug here must stay bare — prefixing it would double-nest the path.
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export default function NewAdrPage() {
  const router = useRouter();
  const templateQuery = useQuery({ queryKey: ["template", "adr"], queryFn: () => api.getTemplate("adr") });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(values: AdrFormValues) {
    setSubmitting(true);
    try {
      const doc = await api.createDoc({
        slug: slugify(values.title),
        title: values.title,
        docType: "adr",
        content: values.content,
        summary: values.summary,
        tags: values.tags,
        message: `create ADR: ${values.title}`,
      });
      router.push(`/docs/${doc.slug}`);
    } catch (err) {
      alert((err as Error).message);
      setSubmitting(false);
    }
  }

  if (templateQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading template...</p>;

  return (
    // Page owns its own scroll region + padding (AppShell's <main> is
    // unpadded and overflow-hidden by design) -- matches the pattern used on
    // /docs and /docs/[slug] so a long template/content textarea can't get
    // clipped with no way to scroll to Cancel/Create.
    <div className="flex-1 overflow-y-auto px-8 pb-[60px] pt-7">
      <Link href="/docs" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← Back to docs
      </Link>
      <h1 className="mb-4 text-2xl font-bold text-foreground">New ADR</h1>
      <AdrForm
        templateContent={templateQuery.data?.content ?? ""}
        onSubmit={handleSubmit}
        submitting={submitting}
        onCancel={() => router.push("/docs")}
      />
    </div>
  );
}
