import { describe, expect, it } from "vitest";
import { CARD_STATES, DEPLOY_STATUSES, GATE_RESULT_STATUSES } from "@loopeng/shared";
import { getStatusMeta, STATUS_META } from "./status";

describe("status.ts", () => {
  it("has an entry for every CardState", () => {
    for (const state of CARD_STATES) {
      expect(STATUS_META[state], `missing meta for card state "${state}"`).toBeDefined();
    }
  });

  it("has an entry for every GateResultStatus", () => {
    for (const status of GATE_RESULT_STATUSES) {
      expect(STATUS_META[status], `missing meta for gate status "${status}"`).toBeDefined();
    }
  });

  it("has an entry for every DeployStatus", () => {
    for (const status of DEPLOY_STATUSES) {
      expect(STATUS_META[status], `missing meta for deploy status "${status}"`).toBeDefined();
    }
  });

  it("falls back gracefully for an unknown key", () => {
    const fallback = getStatusMeta("totally_unknown" as never);
    expect(fallback.label).toBe("totally_unknown");
    expect(fallback.tone).toBe("neutral");
  });

  it("every entry has a non-empty label, tone, dot class and icon", () => {
    for (const [key, entry] of Object.entries(STATUS_META)) {
      expect(entry.label, key).toBeTruthy();
      expect(entry.tone, key).toBeTruthy();
      expect(entry.dotClassName, key).toBeTruthy();
      expect(entry.textClassName, key).toBeTruthy();
      expect(entry.Icon, key).toBeTypeOf("function");
    }
  });
});
