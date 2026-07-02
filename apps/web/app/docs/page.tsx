"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@loopeng/ui";
import { api } from "../../lib/api";

const DOC_TYPES = ["wiki", "adr", "rfc", "skill"] as const;

export default function DocsPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const docsQuery = useQuery({ queryKey: ["docs", filter], queryFn: () => api.listDocs(filter) });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant={!filter ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(undefined)}>
            All
          </Button>
          {DOC_TYPES.map((t) => (
            <Button key={t} variant={filter === t ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(t)}>
              {t}
            </Button>
          ))}
        </div>
        <Link href="/docs/new/adr" className="text-sm text-primary hover:underline">
          + New ADR
        </Link>
      </div>

      {docsQuery.isLoading && <p>Loading...</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(docsQuery.data ?? []).map((doc) => (
            <TableRow key={doc.id}>
              <TableCell>
                <Link href={`/docs/${doc.slug}`} className="text-primary hover:underline">
                  {doc.title}
                </Link>
              </TableCell>
              <TableCell>{doc.docType}</TableCell>
              <TableCell>{doc.status}</TableCell>
              <TableCell>{doc.tags.join(", ")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
