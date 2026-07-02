"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Input, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@loopeng/ui";
import { api } from "../../../lib/api";

export default function CardDetailPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = use(params);
  const queryClient = useQueryClient();
  const detailQuery = useQuery({ queryKey: ["card-detail", cardId], queryFn: () => api.getCardDetail(cardId) });

  const [criteria, setCriteria] = useState<string[]>([]);
  const [newCriterion, setNewCriterion] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (detailQuery.data) setCriteria(detailQuery.data.acceptanceCriteria);
  }, [detailQuery.data]);

  if (detailQuery.isLoading) return <p>Loading...</p>;
  if (!detailQuery.data) return <p>Not found.</p>;

  const card = detailQuery.data;

  async function saveCriteria(next: string[]) {
    setCriteria(next);
    setSaving(true);
    try {
      await api.updateCard(cardId, { acceptanceCriteria: next });
      queryClient.invalidateQueries({ queryKey: ["card-detail", cardId] });
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function addCriterion() {
    const value = newCriterion.trim();
    if (!value) return;
    saveCriteria([...criteria, value]);
    setNewCriterion("");
  }

  function removeCriterion(index: number) {
    saveCriteria(criteria.filter((_, i) => i !== index));
  }

  return (
    <div className="max-w-[720px]">
      <Link href="/board" className="text-sm text-primary hover:underline">
        ← Back to board
      </Link>
      <h1 className="mt-2 text-2xl font-bold">{card.title}</h1>
      <div className="mb-4 flex gap-3 text-xs text-muted-foreground">
        <span>{card.cardType}</span>
        <span>risk: {card.riskTier}</span>
        <span>priority: P{card.priority}</span>
        <span>state: {card.state}</span>
      </div>

      {card.description && <p className="mb-4">{card.description}</p>}

      {card.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {card.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <h3 className="mb-2 text-lg font-semibold">Acceptance criteria</h3>
      <ul className="list-none p-0">
        {criteria.map((criterion, index) => (
          <li key={index} className="mb-1 flex items-center gap-2">
            <span>{criterion}</span>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => removeCriterion(index)} className="h-auto px-1.5 py-0.5 text-[11px]">
              remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="mb-6 flex gap-2">
        <Input
          value={newCriterion}
          onChange={(e) => setNewCriterion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCriterion()}
          placeholder="Add acceptance criterion"
          className="flex-1"
        />
        <Button disabled={saving} onClick={addCriterion}>
          Add
        </Button>
      </div>

      <h3 className="mb-2 text-lg font-semibold">Dependencies</h3>
      {card.dependsOn.length === 0 ? (
        <p className="text-xs text-muted-foreground">No dependencies.</p>
      ) : (
        <ul className="mb-4 list-disc pl-5 text-sm">
          {card.dependsOn.map((dep) => (
            <li key={dep.dependsOnCardId}>
              <Link href={`/card/${dep.dependsOnCardId}`} className="text-primary hover:underline">
                {dep.dependsOnCardId}
              </Link>{" "}
              ({dep.dependencyType})
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-lg font-semibold">Dependents</h3>
      {card.dependents.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing depends on this card.</p>
      ) : (
        <ul className="mb-4 list-disc pl-5 text-sm">
          {card.dependents.map((dep) => (
            <li key={dep.cardId}>
              <Link href={`/card/${dep.cardId}`} className="text-primary hover:underline">
                {dep.cardId}
              </Link>{" "}
              ({dep.dependencyType})
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-lg font-semibold">Linked docs</h3>
      {card.linkedDocs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No linked docs.</p>
      ) : (
        <ul className="mb-4 list-disc pl-5 text-sm">
          {card.linkedDocs.map((link) => (
            <li key={link.docId}>
              <Link href={`/docs/${link.slug}`} className="text-primary hover:underline">
                {link.title}
              </Link>{" "}
              ({link.linkType})
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-lg font-semibold">Agent runs</h3>
      {card.agentRuns.length === 0 ? (
        <p className="text-xs text-muted-foreground">No agent runs yet.</p>
      ) : (
        <Table className="mb-6 text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {card.agentRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{run.roleName ?? "—"}</TableCell>
                <TableCell>{run.status}</TableCell>
                <TableCell>{run.verdict ?? "—"}</TableCell>
                <TableCell>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</TableCell>
                <TableCell>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <h3 className="mb-2 text-lg font-semibold">Gate results</h3>
      {card.gateResults.length === 0 ? (
        <p className="text-xs text-muted-foreground">No gate results yet.</p>
      ) : (
        <Table className="mb-6 text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Gate</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {card.gateResults.map((gate) => (
              <TableRow key={gate.id}>
                <TableCell>{gate.name}</TableCell>
                <TableCell>{gate.status}</TableCell>
                <TableCell>{new Date(gate.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <h3 className="mb-2 text-lg font-semibold">Event timeline</h3>
      {card.events.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events recorded.</p>
      ) : (
        <ul className="list-none p-0 text-xs">
          {card.events.map((event) => (
            <li key={event.id} className="mb-1">
              <span className="text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span> — {event.eventType}
              {event.payload.to ? ` (${String(event.payload.from ?? "?")} → ${String(event.payload.to)})` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
