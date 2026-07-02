import { useState } from "react";

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
      style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}
    >
      <label>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Title</div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          style={{ width: "100%", padding: 8, border: "1px solid #cbd5e0", borderRadius: 4 }}
        />
      </label>
      <label>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Tags (comma separated)</div>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          style={{ width: "100%", padding: 8, border: "1px solid #cbd5e0", borderRadius: 4 }}
        />
      </label>
      <label>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Content</div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={18}
          style={{ width: "100%", padding: 8, border: "1px solid #cbd5e0", borderRadius: 4, fontFamily: "monospace" }}
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        style={{ padding: "8px 16px", background: "#2b6cb0", color: "#fff", border: "none", borderRadius: 4 }}
      >
        {submitting ? "Creating..." : "Create ADR"}
      </button>
    </form>
  );
}
