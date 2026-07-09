import { describe, expect, it } from "vitest";
import {
  buildActiveAgentRunMap,
  buildBlockedReasonMap,
  type ActiveRunRow,
  type FailingGateRow,
  type FailingRunRow,
  type OpenQuestionRow,
} from "./card-status.js";

describe("buildBlockedReasonMap", () => {
  it("picks the failing gate when it is more recent than any failed run", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "security_scan", createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "reviewer",
        verdict: "fail",
        status: "failed",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T00:05:00Z"),
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, runRows);
    expect(result.get("card-1")).toBe("security_scan failed");
  });

  it("prefers a failing gate's specific detail.reason over the generic '<key> failed' message", () => {
    const gateRows: FailingGateRow[] = [
      {
        cardId: "card-1",
        gateKey: "repo_valid",
        detail: { reason: "target repo missing or not a git repository: /bad/path" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, []);
    expect(result.get("card-1")).toBe("target repo missing or not a git repository: /bad/path");
  });

  it("falls back to the generic '<key> failed' message when detail has no reason field", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "tests_ci", detail: { exitCode: 1 }, createdAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, []);
    expect(result.get("card-1")).toBe("tests_ci failed");
  });

  it("picks the rejected agent run when it is more recent than any failing gate", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "security_scan", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "reviewer",
        verdict: "fail",
        status: "succeeded",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        finishedAt: new Date("2026-01-02T00:05:00Z"),
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, runRows);
    expect(result.get("card-1")).toBe("reviewer rejected");
  });

  it("formats a failed (non-rejected) agent run distinctly from a rejected one", () => {
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "implementer",
        verdict: null,
        status: "failed",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T00:05:00Z"),
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], [], runRows);
    expect(result.get("card-1")).toBe("implementer failed");
  });

  it("falls back to a generic honest reason when nothing failing explains the block", () => {
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "implementer",
        verdict: "pass",
        status: "succeeded",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: new Date("2026-01-01T00:05:00Z"),
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], [], runRows);
    expect(result.get("card-1")).toBe("blocked with no recorded cause -- check agent run and gate history on the card detail page");
  });

  it("explains a blocked card whose latest run is stuck running/verifying (orphaned by a process restart)", () => {
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "implementer",
        verdict: null,
        status: "running",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        finishedAt: null,
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], [], runRows);
    expect(result.get("card-1")).toBe('implementer run interrupted (stuck in "running" -- likely an API restart mid-run)');
  });

  it("prefers an actual failing gate over a stuck running run", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "tests_ci", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const runRows: FailingRunRow[] = [
      {
        cardId: "card-1",
        roleName: "implementer",
        verdict: null,
        status: "running",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        finishedAt: null,
      },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, runRows);
    expect(result.get("card-1")).toBe("tests_ci failed");
  });

  it("does not leak a specific reason across cards (card-1 gets the generic fallback instead)", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-2", gateKey: "tests_ci", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const result = buildBlockedReasonMap(["card-1", "card-2"], gateRows, []);
    expect(result.get("card-1")).toBe("blocked with no recorded cause -- check agent run and gate history on the card detail page");
    expect(result.get("card-2")).toBe("tests_ci failed");
  });

  it("picks an open question when it is more recent than any failing gate or run", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "security_scan", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const questionRows: OpenQuestionRow[] = [
      { cardId: "card-1", question: "which env should this deploy to?", createdAt: new Date("2026-01-02T00:00:00Z") },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, [], questionRows);
    expect(result.get("card-1")).toBe("waiting on answer: which env should this deploy to?");
  });

  it("truncates a long open question", () => {
    const longQuestion = "a".repeat(150);
    const questionRows: OpenQuestionRow[] = [
      { cardId: "card-1", question: longQuestion, createdAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildBlockedReasonMap(["card-1"], [], [], questionRows);
    expect(result.get("card-1")).toBe(`waiting on answer: ${"a".repeat(100)}…`);
  });

  it("ignores an open question that is older than a failing gate", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-1", gateKey: "security_scan", createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    const questionRows: OpenQuestionRow[] = [
      { cardId: "card-1", question: "stale question", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildBlockedReasonMap(["card-1"], gateRows, [], questionRows);
    expect(result.get("card-1")).toBe("security_scan failed");
  });
});

describe("buildActiveAgentRunMap", () => {
  it("returns the most recent running/verifying run per card, given rows sorted startedAt DESC", () => {
    const rows: ActiveRunRow[] = [
      { id: "run-2", cardId: "card-1", roleName: "reviewer", status: "verifying", startedAt: new Date("2026-01-02T00:00:00Z") },
      { id: "run-1", cardId: "card-1", roleName: "implementer", status: "running", startedAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildActiveAgentRunMap(rows);
    expect(result.get("card-1")).toEqual({
      agentRunId: "run-2",
      roleName: "reviewer",
      status: "verifying",
      live: false,
      snippet: null,
    });
  });

  it("excludes cards whose most recent run already finished", () => {
    const rows: ActiveRunRow[] = [
      { id: "run-1", cardId: "card-1", roleName: "implementer", status: "succeeded", startedAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildActiveAgentRunMap(rows);
    expect(result.has("card-1")).toBe(false);
  });

  it("defaults a null role name through unchanged", () => {
    const rows: ActiveRunRow[] = [{ id: "run-1", cardId: "card-1", roleName: null, status: "running", startedAt: new Date() }];
    const result = buildActiveAgentRunMap(rows);
    expect(result.get("card-1")).toEqual({
      agentRunId: "run-1",
      roleName: null,
      status: "running",
      live: false,
      snippet: null,
    });
  });

  it("marks a run live when the injected registry check recognizes its id", () => {
    const rows: ActiveRunRow[] = [
      { id: "run-live", cardId: "card-1", roleName: "implementer", status: "running", startedAt: new Date() },
      { id: "run-dead", cardId: "card-2", roleName: "reviewer", status: "running", startedAt: new Date() },
    ];
    const result = buildActiveAgentRunMap(rows, (id) => id === "run-live");
    expect(result.get("card-1")?.live).toBe(true);
    expect(result.get("card-2")?.live).toBe(false);
  });
});
