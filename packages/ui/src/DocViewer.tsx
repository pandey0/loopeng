import ReactMarkdown from "react-markdown";
import type { DocStatus } from "@loopeng/shared";

export interface DocVersionSummary {
  commitSha: string;
  message: string;
  createdAt: string | Date;
}

export interface DocViewerProps {
  title: string;
  status: DocStatus;
  tags: string[];
  body: string;
  versions?: DocVersionSummary[];
  linkedCards?: { id: string; title: string }[];
}

export function DocViewer({ title, status, tags, body, versions = [], linkedCards = [] }: DocViewerProps) {
  return (
    <div style={{ display: "flex", gap: 24 }}>
      <div style={{ flex: 1, maxWidth: 760 }}>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>
        <div style={{ fontSize: 12, color: "#718096", marginBottom: 16 }}>
          <span style={{ textTransform: "uppercase", fontWeight: 700 }}>{status}</span>
          {tags.length > 0 && <span> · {tags.join(", ")}</span>}
        </div>
        <div style={{ lineHeight: 1.6 }}>
          <ReactMarkdown>{body}</ReactMarkdown>
        </div>
      </div>
      <aside style={{ width: 220, fontSize: 12 }}>
        {linkedCards.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Linked cards</div>
            {linkedCards.map((c) => (
              <div key={c.id}>{c.title}</div>
            ))}
          </div>
        )}
        {versions.length > 0 && (
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>History</div>
            {versions.map((v) => (
              <div key={v.commitSha} style={{ marginBottom: 6 }}>
                <div style={{ fontFamily: "monospace" }}>{v.commitSha.slice(0, 7)}</div>
                <div style={{ color: "#718096" }}>{v.message}</div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
