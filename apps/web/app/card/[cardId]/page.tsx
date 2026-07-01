"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
    <div style={{ maxWidth: 720 }}>
      <Link href="/board">← Back to board</Link>
      <h1 style={{ marginTop: 8 }}>{card.title}</h1>
      <div style={{ fontSize: 12, color: "#718096", display: "flex", gap: 12, marginBottom: 16 }}>
        <span>{card.cardType}</span>
        <span>risk: {card.riskTier}</span>
        <span>priority: P{card.priority}</span>
        <span>state: {card.state}</span>
      </div>

      {card.description && <p>{card.description}</p>}

      {card.tags.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {card.tags.map((tag) => (
            <span
              key={tag}
              style={{ fontSize: 11, background: "#edf2f7", borderRadius: 4, padding: "2px 6px", marginRight: 6 }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <h3>Acceptance criteria</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {criteria.map((criterion, index) => (
          <li key={index} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span>{criterion}</span>
            <button disabled={saving} onClick={() => removeCriterion(index)} style={{ fontSize: 11, cursor: "pointer" }}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          value={newCriterion}
          onChange={(e) => setNewCriterion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCriterion()}
          placeholder="Add acceptance criterion"
          style={{ flex: 1, padding: 4 }}
        />
        <button disabled={saving} onClick={addCriterion}>
          Add
        </button>
      </div>

      <h3>Dependencies</h3>
      {card.dependsOn.length === 0 ? (
        <p style={{ fontSize: 12, color: "#718096" }}>No dependencies.</p>
      ) : (
        <ul>
          {card.dependsOn.map((dep) => (
            <li key={dep.dependsOnCardId}>
              <Link href={`/card/${dep.dependsOnCardId}`}>{dep.dependsOnCardId}</Link> ({dep.dependencyType})
            </li>
          ))}
        </ul>
      )}

      <h3>Dependents</h3>
      {card.dependents.length === 0 ? (
        <p style={{ fontSize: 12, color: "#718096" }}>Nothing depends on this card.</p>
      ) : (
        <ul>
          {card.dependents.map((dep) => (
            <li key={dep.cardId}>
              <Link href={`/card/${dep.cardId}`}>{dep.cardId}</Link> ({dep.dependencyType})
            </li>
          ))}
        </ul>
      )}

      <h3>Linked docs</h3>
      {card.docLinks.length === 0 ? (
        <p style={{ fontSize: 12, color: "#718096" }}>No linked docs.</p>
      ) : (
        <ul>
          {card.docLinks.map((link) => (
            <li key={link.docId}>
              {link.docId} ({link.linkType})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
