import type { Connector, NotifyPayload } from "./types.js";

export interface LinearConnectorConfig {
  apiKey?: string;
}

// notify() adds a comment to the Linear issue given in payload.context.issueId.
// No-ops without LINEAR_API_KEY or an issueId — cards don't yet carry a linked
// Linear issue, so this is exercised once that mapping exists.
export class LinearConnector implements Connector {
  readonly type = "linear" as const;

  constructor(private readonly config: LinearConnectorConfig) {}

  async notify(payload: NotifyPayload): Promise<void> {
    const apiKey = this.config.apiKey ?? process.env.LINEAR_API_KEY;
    const issueId = payload.context?.issueId;
    if (!apiKey || !issueId) {
      console.warn("[connectors:linear] not configured or no issueId, skipping notify:", payload.text);
      return;
    }
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        variables: { issueId, body: payload.text },
      }),
    });
    if (!res.ok) {
      throw new Error(`linear comment failed: ${res.status} ${await res.text()}`);
    }
  }
}
