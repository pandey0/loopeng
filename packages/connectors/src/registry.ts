import { eq } from "drizzle-orm";
import { db } from "@loopeng/db";
import { connectors as connectorsTable } from "@loopeng/db";
import { GithubConnector } from "./github.js";
import { LinearConnector } from "./linear.js";
import { SlackConnector } from "./slack.js";
import type { Connector, NotifyPayload } from "./types.js";

export class ConnectorRegistry {
  private readonly byType = new Map<string, Connector>();

  register(connector: Connector) {
    this.byType.set(connector.type, connector);
  }

  get(type: Connector["type"]): Connector | undefined {
    return this.byType.get(type);
  }

  async notifyAll(payload: NotifyPayload): Promise<void> {
    await Promise.all(
      [...this.byType.values()].map((c) =>
        c.notify(payload).catch((err) => console.error(`[connectors:${c.type}] notify failed`, err)),
      ),
    );
  }
}

export async function loadConnectorRegistry(): Promise<ConnectorRegistry> {
  const registry = new ConnectorRegistry();
  const rows = await db.select().from(connectorsTable).where(eq(connectorsTable.enabled, true));

  for (const row of rows) {
    const config = row.config as Record<string, unknown>;
    switch (row.type) {
      case "slack":
        registry.register(new SlackConnector({ webhookUrl: config.webhookUrl as string | undefined }));
        break;
      case "github":
        registry.register(
          new GithubConnector({ token: config.token as string | undefined, repo: config.repo as string | undefined }),
        );
        break;
      case "linear":
        registry.register(new LinearConnector({ apiKey: config.apiKey as string | undefined }));
        break;
    }
  }

  // Fall back to env-configured Slack even with no DB row, so onFailure
  // notifications work out of the box once SLACK_WEBHOOK_URL is set.
  if (!registry.get("slack") && process.env.SLACK_WEBHOOK_URL) {
    registry.register(new SlackConnector({}));
  }

  return registry;
}

export * from "./types.js";
export { GithubConnector, LinearConnector, SlackConnector };
