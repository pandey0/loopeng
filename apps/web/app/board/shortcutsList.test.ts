import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./shortcutsList";

describe("shortcuts help list", () => {
  it("lists the '/' shortcut for focusing title search", () => {
    const entry = SHORTCUTS.find((s) => s.keys === "/");
    expect(entry).toBeDefined();
    expect(entry?.label.toLowerCase()).toContain("search");
  });
});
