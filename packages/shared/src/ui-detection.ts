// Shared predicate for "does this card need the designer role" — used by
// packages/gates (design_review gate's appliesTo()) and, indirectly via that
// gate, by the orchestrator loop's upstream/downstream designer hooks. Split
// out as pure string/array checks (no DB) so both call sites stay in sync
// and the logic is unit-testable without a database.

const UI_TAGS = new Set(["ui", "ux"]);

// Fallback signal, since tags are set manually and often missed: a linked
// spec doc that explicitly calls out a UI-owning path still qualifies.
const UI_PATH_PATTERN = /(apps\/web|packages\/ui)/;

export function cardTagsIndicateUi(tags: string[]): boolean {
  return tags.some((t) => UI_TAGS.has(t.toLowerCase()));
}

export function textMentionsUiPaths(text: string): boolean {
  return UI_PATH_PATTERN.test(text);
}
