"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  StatusBadge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Tabs,
} from "@loopeng/ui";
import { api } from "../../../lib/api";

interface TimelineRow {
  at: Date;
  kind: "agent_run" | "gate_result" | "event";
  label: string;
  detail: string;
}

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

  const timeline = useMemo<TimelineRow[]>(() => {
    if (!detailQuery.data) return [];
    const card = detailQuery.data;
    const rows: TimelineRow[] = [];

    for (const run of card.agentRuns) {
      const at = run.startedAt ?? run.finishedAt;
      if (!at) continue;
      rows.push({
        at: new Date(at),
        kind: "agent_run",
        label: run.roleName ?? "agent run",
        detail: `${run.status}${run.verdict ? ` — verdict: ${run.verdict}` : ""}`,
      });
    }
    for (const gate of card.gateResults) {
      rows.push({
        at: new Date(gate.createdAt),
        kind: "gate_result",
        label: gate.name,
        detail: gate.status,
      });
    }
    for (const event of card.events) {
      const { from, to } = event.payload as { from?: string; to?: string };
      rows.push({
        at: new Date(event.createdAt),
        kind: "event",
        label: event.eventType,
        detail: to ? `${String(from ?? "?")} → ${String(to)}` : "",
      });
    }

    return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
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

  const overview = (
    <div>
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
    </div>
  );

  const activity = (
    <div>
      <h3 className="mb-2 text-lg font-semibold">Timeline</h3>
      {timeline.length === 0 ? (
        <p className="mb-6 text-xs text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <ul className="mb-6 list-none p-0 text-xs">
          {timeline.map((row, index) => (
            <li key={index} className="mb-1.5 flex items-start gap-2">
              <span className="w-36 shrink-0 text-muted-foreground">{row.at.toLocaleString()}</span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {row.kind === "agent_run" ? "agent" : row.kind === "gate_result" ? "gate" : "event"}
              </Badge>
              <span>
                <span className="font-medium">{row.label}</span>
                {row.detail && <> — {row.detail}</>}
              </span>
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
        <Table className="text-xs">
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
                <TableCell>
                  <StatusBadge status={gate.status as import("@loopeng/shared").GateResultStatus} />
                </TableCell>
                <TableCell>{new Date(gate.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );

  return (
    <div className="max-w-[720px]">
      <Link href="/board" className="text-sm text-primary hover:underline">
        ← Back to board
      </Link>
      <h1 className="mt-2 text-2xl font-bold">{card.title}</h1>
      <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{card.cardType}</span>
        <span>risk: {card.riskTier}</span>
        <span>priority: P{card.priority}</span>
        <StatusBadge status={card.state} />
      </div>

      <Tabs
        items={[
          { value: "overview", label: "Overview", content: overview },
          { value: "activity", label: "Activity", content: activity },
        ]}
      />
    </div>
  );
}
