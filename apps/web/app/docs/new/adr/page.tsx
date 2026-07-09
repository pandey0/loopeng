"use client";

import { useState } from "react";
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

  if (templateQuery.isLoading) return <p>Loading template...</p>;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">New ADR</h1>
      <AdrForm
        templateContent={templateQuery.data?.content ?? ""}
        onSubmit={handleSubmit}
        submitting={submitting}
      />
    </div>
  );
}
