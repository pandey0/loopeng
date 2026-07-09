import { describe, expect, it } from "vitest";
import { cardTagsIndicateUi, textMentionsUiPaths } from "./ui-detection";

describe("cardTagsIndicateUi", () => {
  it("matches the ui tag", () => {
    expect(cardTagsIndicateUi(["ui"])).toBe(true);
  });

  it("matches the ux tag case-insensitively", () => {
    expect(cardTagsIndicateUi(["UX"])).toBe(true);
  });

  it("returns false for unrelated tags", () => {
    expect(cardTagsIndicateUi(["backend", "chore"])).toBe(false);
  });

  it("returns false for no tags", () => {
    expect(cardTagsIndicateUi([])).toBe(false);
  });
});

describe("textMentionsUiPaths", () => {
  it("matches apps/web paths", () => {
    expect(textMentionsUiPaths("Update the dashboard in apps/web/src/pages")).toBe(true);
  });

  it("matches packages/ui paths", () => {
    expect(textMentionsUiPaths("Reuse the Button from packages/ui/src/button.tsx")).toBe(true);
  });

  it("returns false when no UI path is mentioned", () => {
    expect(textMentionsUiPaths("Fix the retry logic in the worker")).toBe(false);
  });
});
