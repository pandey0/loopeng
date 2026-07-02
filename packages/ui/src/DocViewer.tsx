import ReactMarkdown from "react-markdown";
import type { DocStatus } from "@loopeng/shared";
import { Badge } from "./components/badge";

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
    <div className="flex gap-6">
      <div className="max-w-[760px] flex-1">
        <h1 className="mb-1 text-2xl font-bold">{title}</h1>
        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="uppercase">
            {status}
          </Badge>
          {tags.length > 0 && <span>{tags.join(", ")}</span>}
        </div>
        <div className="text-sm leading-relaxed [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-semibold [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">

          <ReactMarkdown>{body}</ReactMarkdown>
        </div>
      </div>
      <aside className="w-[220px] text-xs">
        {linkedCards.length > 0 && (
          <div className="mb-5">
            <div className="mb-1.5 font-bold">Linked cards</div>
            {linkedCards.map((c) => (
              <div key={c.id}>{c.title}</div>
            ))}
          </div>
        )}
        {versions.length > 0 && (
          <div>
            <div className="mb-1.5 font-bold">History</div>
            {versions.map((v) => (
              <div key={v.commitSha} className="mb-1.5">
                <div className="font-mono">{v.commitSha.slice(0, 7)}</div>
                <div className="text-muted-foreground">{v.message}</div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
