import type { Board, Card, CardDependency, CardState, Doc } from "@loopeng/shared";

export interface CardDetailDocLink {
  docId: string;
  slug: string;
  title: string;
  docType: string;
  linkType: string;
}

export interface CardDetailAgentRun {
  id: string;
  roleName: string | null;
  status: string;
  verdict: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CardDetailGateResult {
  id: string;
  key: string;
  name: string;
  status: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface CardDetailEvent {
  id: number;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityEvent {
  id: number;
  entityType: string;
  entityId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CardDetail extends Card {
  dependsOn: CardDependency[];
  dependents: CardDependency[];
  linkedDocs: CardDetailDocLink[];
  agentRuns: CardDetailAgentRun[];
  gateResults: CardDetailGateResult[];
  events: CardDetailEvent[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listBoards: () => request<Board[]>("/boards"),
  getBoard: (id: string) => request<Board & { cards: Card[] }>(`/boards/${id}`),
  createBoard: (input: { name: string; description?: string }) =>
    request<Board>("/boards", { method: "POST", body: JSON.stringify(input) }),

  listCards: (boardId?: string) =>
    request<Card[]>(`/cards${boardId ? `?boardId=${boardId}` : ""}`),
  createCard: (input: {
    boardId: string;
    title: string;
    description?: string;
    cardType?: string;
    riskTier?: string;
    priority?: number;
  }) => request<Card>("/cards", { method: "POST", body: JSON.stringify(input) }),
  transitionCard: (id: string, toState: CardState) =>
    request<Card>(`/cards/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ toState, actorType: "user" }),
    }),
  getCardDetail: (id: string) => request<CardDetail>(`/cards/${id}/detail`),
  updateCard: (
    id: string,
    input: Partial<{
      title: string;
      description: string | null;
      cardType: string;
      riskTier: string;
      priority: number;
      tags: string[];
      acceptanceCriteria: string[];
      assigneeId: string | null;
    }>,
  ) => request<Card>(`/cards/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  addCardDependency: (id: string, dependsOnCardId: string, dependencyType: "blocks" | "relates_to" = "blocks") =>
    request(`/cards/${id}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnCardId, dependencyType }),
    }),
  listCardDependencies: (id: string) =>
    request<{ cardId: string; dependsOnCardId: string; dependencyType: string }[]>(
      `/cards/${id}/dependencies`,
    ),
  linkCardDoc: (id: string, docId: string, linkType: "spec" | "adr" | "skill" | "related") =>
    request(`/cards/${id}/doc-links`, {
      method: "POST",
      body: JSON.stringify({ docId, linkType }),
    }),

  listEvents: (params?: { boardId?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.boardId) qs.set("boardId", params.boardId);
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return request<ActivityEvent[]>(`/events${query ? `?${query}` : ""}`);
  },
  eventsStreamUrl: (boardId?: string) => `${API_URL}/events/stream${boardId ? `?boardId=${boardId}` : ""}`,

  getTemplate: (docType: "adr" | "rfc" | "skill") =>
    request<{ docType: string; content: string }>(`/docs/templates/${docType}`),
  listDocs: (docType?: string) => request<Doc[]>(`/docs${docType ? `?docType=${docType}` : ""}`),
  getDoc: (slug: string) =>
    request<Doc & { body: string; frontmatter: Record<string, unknown> }>(`/docs/${slug}`),
  getDocVersions: (slug: string) =>
    request<{ commitSha: string; message: string; createdAt: string }[]>(`/docs/${slug}/versions`),
  createDoc: (input: {
    slug: string;
    title: string;
    docType: string;
    content: string;
    tags?: string[];
    message?: string;
  }) => request<Doc>("/docs", { method: "POST", body: JSON.stringify(input) }),
};
