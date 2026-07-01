import type { Connector, NotifyPayload } from "./types.js";

export interface GithubConnectorConfig {
  token?: string;
  repo?: string; // "owner/name"
}

// notify() posts a comment on the issue/PR number given in payload.context.issueNumber.
// Without that (or without GITHUB_TOKEN/repo configured), it safely no-ops — cards don't
// yet carry a linked PR number, so this is exercised once that mapping exists.
export class GithubConnector implements Connector {
  readonly type = "github" as const;

  constructor(private readonly config: GithubConnectorConfig) {}

  async notify(payload: NotifyPayload): Promise<void> {
    const token = this.config.token ?? process.env.GITHUB_TOKEN;
    const repo = this.config.repo ?? process.env.GITHUB_REPO;
    const issueNumber = payload.context?.issueNumber;
    if (!token || !repo || !issueNumber) {
      console.warn("[connectors:github] not configured or no issueNumber, skipping notify:", payload.text);
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: payload.text }),
    });
    if (!res.ok) {
      throw new Error(`github comment failed: ${res.status} ${await res.text()}`);
    }
  }
}
