import { describe, expect, it } from "vitest";
import {
  buildActiveAgentRunMap,
  buildBlockedReasonMap,
  type ActiveRunRow,
  type FailingGateRow,
  type FailingRunRow,
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

  it("ignores passing gates and non-failing runs, leaving no reason", () => {
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
    expect(result.has("card-1")).toBe(false);
  });

  it("does not leak reasons across cards", () => {
    const gateRows: FailingGateRow[] = [
      { cardId: "card-2", gateKey: "tests_ci", createdAt: new Date("2026-01-01T00:00:00Z") },
    ];
    const result = buildBlockedReasonMap(["card-1", "card-2"], gateRows, []);
    expect(result.has("card-1")).toBe(false);
    expect(result.get("card-2")).toBe("tests_ci failed");
  });
});

describe("buildActiveAgentRunMap", () => {
  it("returns the most recent running/verifying run per card, given rows sorted startedAt DESC", () => {
    const rows: ActiveRunRow[] = [
      { cardId: "card-1", roleName: "reviewer", status: "verifying", startedAt: new Date("2026-01-02T00:00:00Z") },
      { cardId: "card-1", roleName: "implementer", status: "running", startedAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildActiveAgentRunMap(rows);
    expect(result.get("card-1")).toEqual({ roleName: "reviewer", status: "verifying" });
  });

  it("excludes cards whose most recent run already finished", () => {
    const rows: ActiveRunRow[] = [
      { cardId: "card-1", roleName: "implementer", status: "succeeded", startedAt: new Date("2026-01-01T00:00:00Z") },
    ];

    const result = buildActiveAgentRunMap(rows);
    expect(result.has("card-1")).toBe(false);
  });

  it("defaults a null role name through unchanged", () => {
    const rows: ActiveRunRow[] = [{ cardId: "card-1", roleName: null, status: "running", startedAt: new Date() }];
    const result = buildActiveAgentRunMap(rows);
    expect(result.get("card-1")).toEqual({ roleName: null, status: "running" });
  });
});
