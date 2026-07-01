import type { Connector, NotifyPayload } from "./types.js";

export interface SlackConnectorConfig {
  webhookUrl?: string;
}

export class SlackConnector implements Connector {
  readonly type = "slack" as const;

  constructor(private readonly config: SlackConnectorConfig) {}

  async notify(payload: NotifyPayload): Promise<void> {
    const webhookUrl = this.config.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("[connectors:slack] no webhook configured, skipping notify:", payload.text);
      return;
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: payload.text }),
    });
    if (!res.ok) {
      throw new Error(`slack webhook failed: ${res.status} ${await res.text()}`);
    }
  }
}
