"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, LiveIndicator, cn, toChatItems, type ChatItem, type TranscriptEvent } from "@loopeng/ui";
import { api } from "../../../lib/api";

function stringifyToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function CollapsibleEvent({ summary, payload, isError = false }: { summary: string; payload: unknown; isError?: boolean }) {
  const text = stringifyToolPayload(payload);
  return (
    <details className={cn("rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs", isError && "border-destructive/50")}>
      <summary className={cn("cursor-pointer select-none font-medium", isError ? "text-destructive" : "text-muted-foreground")}>
        {summary}
      </summary>
      {text && <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px]">{text}</pre>}
    </details>
  );
}

export interface AgentSessionPanelProps {
  agentRunId: string;
  roleName: string | null;
  /** Whether the run had an attachable live session when the panel opened. */
  live: boolean;
}

// Chat-style view of an agent run's transcript over the card-C WebSocket.
// The same socket serves both modes: a live run replays what happened so far
// and then streams new events (with an input box to steer the agent); a
// completed run streams the persisted transcript once and closes, leaving a
// read-only playback with no input box.
export function AgentSessionPanel({ agentRunId, roleName, live }: AgentSessionPanelProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [connectionState, setConnectionState] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [draft, setDraft] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const socket = new WebSocket(api.agentRunSocketUrl(agentRunId));
    socketRef.current = socket;

    socket.onopen = () => setConnectionState("open");
    socket.onmessage = (frame) => {
      let event: TranscriptEvent;
      try {
        event = JSON.parse(String(frame.data));
      } catch {
        return;
      }
      const next = toChatItems(event);
      if (next.length) setItems((prev) => [...prev, ...next]);
    };
    socket.onclose = () => setConnectionState("closed");
    socket.onerror = () => setConnectionState("error");

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [agentRunId]);

  // Keep the newest message in view as events stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  function sendMessage() {
    const text = draft.trim();
    const socket = socketRef.current;
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "input", text }));
    setDraft("");
  }

  // Input only makes sense while there's a process to steer: the run was live
  // when opened and the socket hasn't closed (the server closes it when the
  // session ends). A completed run's playback never shows an input box.
  const canSend = live && connectionState === "open";

  return (
    <div className="flex h-[60vh] flex-col">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{roleName ?? "agent"}</Badge>
        {canSend ? (
          <LiveIndicator />
        ) : (
          <span>
            {connectionState === "connecting"
              ? "connecting…"
              : connectionState === "error"
                ? "connection error"
                : "read-only playback"}
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto rounded-md border bg-background p-3">
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {connectionState === "connecting" ? "Connecting…" : "No transcript events."}
          </p>
        )}
        {items.map((item, index) => {
          switch (item.kind) {
            case "assistant_text":
              return (
                <div key={index} className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
                  {item.text}
                </div>
              );
            case "human_text":
              return (
                <div key={index} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {item.text}
                </div>
              );
            case "tool_use":
              return <CollapsibleEvent key={index} summary={`tool: ${item.name}`} payload={item.input} />;
            case "tool_result":
              return (
                <CollapsibleEvent
                  key={index}
                  summary={item.isError ? "tool result (error)" : "tool result"}
                  payload={item.content}
                  isError={item.isError}
                />
              );
            case "status":
              return (
                <div key={index} className={cn("text-center text-[11px]", item.isError ? "text-destructive" : "text-muted-foreground")}>
                  — {item.text} —
                </div>
              );
          }
        })}
      </div>

      {canSend && (
        <div className="mt-2 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Send a message to the agent…"
            className="flex-1"
          />
          <Button onClick={sendMessage} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      )}
    </div>
  );
}
