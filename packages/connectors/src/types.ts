export interface NotifyPayload {
  text: string;
  context?: Record<string, unknown>;
}

// Deliberately transport-agnostic: today's implementations hit a webhook or
// a REST API directly; nothing here prevents a future implementation from
// routing through an MCP server instead — callers only ever see notify().
export interface Connector {
  type: "github" | "slack" | "linear";
  notify(payload: NotifyPayload): Promise<void>;
}
