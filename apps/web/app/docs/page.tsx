"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

const DOC_TYPES = ["wiki", "adr", "rfc", "skill"] as const;

export default function DocsPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const docsQuery = useQuery({ queryKey: ["docs", filter], queryFn: () => api.listDocs(filter) });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setFilter(undefined)} style={{ fontWeight: !filter ? 700 : 400 }}>
            All
          </button>
          {DOC_TYPES.map((t) => (
            <button key={t} onClick={() => setFilter(t)} style={{ fontWeight: filter === t ? 700 : 400 }}>
              {t}
            </button>
          ))}
        </div>
        <Link href="/docs/new/adr">+ New ADR</Link>
      </div>

      {docsQuery.isLoading && <p>Loading...</p>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
            <th style={{ padding: 8 }}>Title</th>
            <th style={{ padding: 8 }}>Type</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Tags</th>
          </tr>
        </thead>
        <tbody>
          {(docsQuery.data ?? []).map((doc) => (
            <tr key={doc.id} style={{ borderBottom: "1px solid #edf2f7" }}>
              <td style={{ padding: 8 }}>
                <Link href={`/docs/${doc.slug}`}>{doc.title}</Link>
              </td>
              <td style={{ padding: 8 }}>{doc.docType}</td>
              <td style={{ padding: 8 }}>{doc.status}</td>
              <td style={{ padding: 8 }}>{doc.tags.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
