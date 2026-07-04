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
