import type { Board, Card, CardDependency, CardState, CardWithStatus, Doc } from "@loopeng/shared";

export interface CardDetailDocLink {
  docId: string;
  slug: string;
  title: string;
  docType: string;
  linkType: string;
}

export interface CardDetailAgentRun {
  id: string;
  /** Set when this run was delegated by another run (sub-agent) — the Activity tab nests it under that parent. */
  parentAgentRunId: string | null;
  roleName: string | null;
  status: string;
  verdict: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** True when the run has an attachable interactive session right now (card C's session registry). */
  live: boolean;
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

export interface IntakeResult {
  agentRunId: string;
  epicCardId: string;
  cardIds: string[];
  specDocId: string;
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

// Carries the parsed JSON error body (when the API sent one) alongside the
// generic message, so callers that want to show the server's actual
// validation/error message (e.g. the intake modal) don't have to re-parse it.
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON, keep the raw text
    }
    const message =
      body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : `${init?.method ?? "GET"} ${path} failed: ${res.status} ${text}`;
    throw new ApiError(message, res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listBoards: () => request<Board[]>("/boards"),
  getBoard: (id: string) => request<Board & { cards: Card[] }>(`/boards/${id}`),
  createBoard: (input: { name: string; description?: string }) =>
    request<Board>("/boards", { method: "POST", body: JSON.stringify(input) }),
  intake: (boardId: string, requestText: string) =>
    request<IntakeResult>(`/boards/${boardId}/intake`, { method: "POST", body: JSON.stringify({ requestText }) }),

  listCards: (boardId?: string) =>
    request<CardWithStatus[]>(`/cards${boardId ? `?boardId=${boardId}` : ""}`),
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
  // WebSocket bridge onto an agent run (card C): live runs replay-then-stream
  // and accept input; completed runs stream the persisted transcript and close.
  agentRunSocketUrl: (agentRunId: string) =>
    `${API_URL.replace(/^http/, "ws")}/agent-runs/${agentRunId}/socket`,

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
