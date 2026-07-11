// Flattens raw stream-json events from an agent-run WebSocket (card C's
// bridge onto the claude CLI) into typed chat items the live chat panel can
// render with a dumb switch: one assistant event with three content blocks
// becomes three items. Pure and DOM-free so the parsing rules are
// unit-testable outside the React component.

/** One raw stream-json event, as emitted by the claude CLI / replayed from agent_runs.transcript. */
export type TranscriptEvent = Record<string, unknown>;

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

export type ChatItem =
  | { kind: "assistant_text"; text: string }
  | { kind: "human_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; content: unknown; isError: boolean }
  | { kind: "status"; text: string; isError: boolean };

function contentBlocks(event: TranscriptEvent): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

/**
 * Maps one wire event to zero or more chat items. Unrenderable events —
 * "stream_event" partial deltas (their content re-arrives in the complete
 * assistant event), non-init system events, unknown types — map to [].
 */
export function toChatItems(event: TranscriptEvent): ChatItem[] {
  if (event.type === "assistant") {
    const items: ChatItem[] = [];
    for (const block of contentBlocks(event)) {
      if (block.type === "text" && block.text?.trim()) {
        items.push({ kind: "assistant_text", text: block.text });
      } else if (block.type === "tool_use") {
        items.push({ kind: "tool_use", name: block.name ?? "tool", input: block.input });
      }
    }
    return items;
  }

  if (event.type === "user") {
    const items: ChatItem[] = [];
    // actor_type === "human" marks a turn relayed from a person over the
    // WebSocket (card C decorates it); undecorated user events are the
    // CLI's own tool-result turns.
    const isHuman = event.actor_type === "human";
    for (const block of contentBlocks(event)) {
      if (block.type === "text" && block.text?.trim()) {
        items.push({ kind: isHuman ? "human_text" : "assistant_text", text: block.text });
      } else if (block.type === "tool_result") {
        items.push({ kind: "tool_result", content: block.content, isError: Boolean(block.is_error) });
      }
    }
    return items;
  }

  if (event.type === "result") {
    const isError = Boolean(event.is_error);
    const cost = typeof event.total_cost_usd === "number" ? ` — $${event.total_cost_usd.toFixed(4)}` : "";
    return [{ kind: "status", text: `${isError ? "turn failed" : "turn finished"}${cost}`, isError }];
  }

  if (event.type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? ` (${event.model})` : "";
    return [{ kind: "status", text: `session started${model}`, isError: false }];
  }

  return [];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Turns a raw tool call into one plain-English line instead of a tool name +
 * a JSON payload — "Reading packages/orchestrator/src/loop.ts" instead of
 * `tool: Read` with an expandable `{ file_path: "..." }`. Covers the
 * standard Claude Code CLI tool set plus a generic fallback for anything
 * else (including MCP tools, named `mcp__<server>__<tool>`) so an unknown
 * tool still reads as a sentence, not raw JSON.
 */
export function describeToolUse(name: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (key: string): string | undefined => (typeof obj[key] === "string" ? (obj[key] as string) : undefined);

  switch (name) {
    case "Read": {
      const path = str("file_path");
      return path ? `📖 Reading ${path}` : "📖 Reading a file";
    }
    case "Edit": {
      const path = str("file_path");
      return path ? `✏️ Editing ${path}` : "✏️ Editing a file";
    }
    case "Write": {
      const path = str("file_path");
      return path ? `📝 Writing ${path}` : "📝 Writing a file";
    }
    case "NotebookEdit": {
      const path = str("notebook_path");
      return path ? `📓 Editing notebook ${path}` : "📓 Editing a notebook";
    }
    case "Bash": {
      const desc = str("description");
      const command = str("command");
      if (desc) return `▶ ${desc}`;
      return command ? `▶ Running: ${truncate(command, 80)}` : "▶ Running a command";
    }
    case "Grep": {
      const pattern = str("pattern");
      const path = str("path");
      return pattern ? `🔍 Searching for "${truncate(pattern, 60)}"${path ? ` in ${path}` : ""}` : "🔍 Searching the codebase";
    }
    case "Glob": {
      const pattern = str("pattern");
      return pattern ? `🔍 Finding files matching "${pattern}"` : "🔍 Finding files";
    }
    case "WebFetch": {
      const url = str("url");
      return url ? `🌐 Fetching ${url}` : "🌐 Fetching a page";
    }
    case "WebSearch": {
      const query = str("query");
      return query ? `🌐 Searching the web for "${query}"` : "🌐 Searching the web";
    }
    case "TodoWrite":
      return "☑ Updating its task list";
    case "Task":
      return `🤝 Delegating: ${str("description") ?? "a sub-task"}`;
    default:
      if (name.startsWith("mcp__")) {
        const short = name.split("__").pop() ?? name;
        return `🔌 ${short.replace(/_/g, " ")}`;
      }
      return `🔧 Using ${name}`;
  }
}
