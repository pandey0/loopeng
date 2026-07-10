"use client";

import { useState } from "react";
import { Label } from "./components/label";
import { Input } from "./components/input";
import { Textarea } from "./components/textarea";
import { Button } from "./components/button";

export interface AdrFormValues {
  title: string;
  summary: string;
  tags: string[];
  content: string;
}

export interface AdrFormProps {
  templateContent: string;
  onSubmit: (values: AdrFormValues) => void | Promise<void>;
  submitting?: boolean;
  /** Optional cancel handler -- when provided, renders a Cancel action next to submit (e.g. navigate back to /docs). */
  onCancel?: () => void;
}

export function AdrForm({ templateContent, onSubmit, submitting = false, onCancel }: AdrFormProps) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState(templateContent);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title,
          summary,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          content,
        });
      }}
      className="flex max-w-[720px] flex-col gap-4"
    >
      <Label>
        Title <span className="text-destructive">*</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1" />
      </Label>
      <div>
        <Label>
          Summary <span className="text-destructive">*</span>
          <Input value={summary} onChange={(e) => setSummary(e.target.value)} required className="mt-1" />
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">One line — shown in agent prompts instead of the full doc.</p>
      </div>
      <Label>
        Tags (comma separated)
        <Input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1" />
      </Label>
      <Label>
        Content
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={18}
          className="mt-1 min-h-[360px] text-[13px]"
        />
      </Label>
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create ADR"}
        </Button>
      </div>
    </form>
  );
}
