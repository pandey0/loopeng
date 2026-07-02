"use client";

import { useState } from "react";
import { Label } from "./components/label";
import { Input } from "./components/input";
import { Textarea } from "./components/textarea";
import { Button } from "./components/button";

export interface AdrFormValues {
  title: string;
  tags: string[];
  content: string;
}

export interface AdrFormProps {
  templateContent: string;
  onSubmit: (values: AdrFormValues) => void | Promise<void>;
  submitting?: boolean;
}

export function AdrForm({ templateContent, onSubmit, submitting = false }: AdrFormProps) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState(templateContent);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          content,
        });
      }}
      className="flex max-w-[720px] flex-col gap-3"
    >
      <Label>
        Title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1" />
      </Label>
      <Label>
        Tags (comma separated)
        <Input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1" />
      </Label>
      <Label>
        Content
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} className="mt-1" />
      </Label>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Creating..." : "Create ADR"}
      </Button>
    </form>
  );
}
