import { describe, expect, it } from "vitest";
import { describeToolUse, toChatItems } from "./agent-transcript";

describe("toChatItems", () => {
  it("renders assistant text blocks as assistant bubbles", () => {
    const items = toChatItems({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    });
    expect(items).toEqual([{ kind: "assistant_text", text: "hello there" }]);
  });

  it("splits a mixed assistant event into text and tool_use items in order", () => {
    const items = toChatItems({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
        ],
      },
    });
    expect(items).toEqual([
      { kind: "assistant_text", text: "let me check" },
      { kind: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
    ]);
  });

  it("drops whitespace-only assistant text blocks", () => {
    expect(toChatItems({ type: "assistant", message: { content: [{ type: "text", text: "  \n" }] } })).toEqual([]);
  });

  it("renders a human-relayed user turn as a human bubble", () => {
    const items = toChatItems({
      type: "user",
      actor_type: "human",
      message: { role: "user", content: [{ type: "text", text: "steer left" }] },
    });
    expect(items).toEqual([{ kind: "human_text", text: "steer left" }]);
  });

  it("renders tool_result blocks from undecorated user events, carrying is_error through", () => {
    const items = toChatItems({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents" },
          { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
        ],
      },
    });
    expect(items).toEqual([
      { kind: "tool_result", content: "file contents", isError: false },
      { kind: "tool_result", content: "boom", isError: true },
    ]);
  });

  it("renders result events as a status line, with cost when present", () => {
    expect(toChatItems({ type: "result", result: "ok", is_error: false, total_cost_usd: 0.1234 })).toEqual([
      { kind: "status", text: "turn finished — $0.1234", isError: false },
    ]);
    expect(toChatItems({ type: "result", is_error: true })).toEqual([
      { kind: "status", text: "turn failed", isError: true },
    ]);
  });

  it("renders the system init event as a session-start status line", () => {
    expect(toChatItems({ type: "system", subtype: "init", model: "claude-haiku-4-5" })).toEqual([
      { kind: "status", text: "session started (claude-haiku-4-5)", isError: false },
    ]);
  });

  it("skips stream_event partial deltas and unknown event types", () => {
    expect(toChatItems({ type: "stream_event", event: { type: "content_block_delta" } })).toEqual([]);
    expect(toChatItems({ type: "system", subtype: "compact" })).toEqual([]);
    expect(toChatItems({ type: "whatever" })).toEqual([]);
  });

  it("tolerates events with no message payload", () => {
    expect(toChatItems({ type: "assistant" })).toEqual([]);
    expect(toChatItems({ type: "user", message: { content: "not-an-array" } })).toEqual([]);
  });
});

describe("describeToolUse", () => {
  it("describes a Read call by file path", () => {
    expect(describeToolUse("Read", { file_path: "packages/orchestrator/src/loop.ts" })).toBe(
      "📖 Reading packages/orchestrator/src/loop.ts",
    );
  });

  it("describes a Bash call using its description when present, not the raw command", () => {
    expect(describeToolUse("Bash", { command: "pnpm test", description: "Run the test suite" })).toBe("▶ Run the test suite");
  });

  it("falls back to a truncated raw command when Bash has no description", () => {
    const longCommand = `echo ${"x".repeat(100)}`;
    const result = describeToolUse("Bash", { command: longCommand });
    expect(result.startsWith("▶ Running: echo ")).toBe(true);
    expect(result.length).toBeLessThan(longCommand.length);
  });

  it("describes Grep with its pattern and path", () => {
    expect(describeToolUse("Grep", { pattern: "ORCHESTRATOR_ENABLED", path: "apps/api" })).toBe(
      '🔍 Searching for "ORCHESTRATOR_ENABLED" in apps/api',
    );
  });

  it("humanizes an MCP tool name instead of showing the raw mcp__server__tool string", () => {
    expect(describeToolUse("mcp__subagent__get_doc", { slug: "some-doc" })).toBe("🔌 get doc");
  });

  it("still produces a sentence, not raw JSON, for a completely unknown tool", () => {
    expect(describeToolUse("SomeFutureTool", { whatever: true })).toBe("🔧 Using SomeFutureTool");
  });

  it("degrades gracefully when input is missing or not an object", () => {
    expect(describeToolUse("Read", undefined)).toBe("📖 Reading a file");
    expect(describeToolUse("Bash", "not-an-object")).toBe("▶ Running a command");
  });
});
