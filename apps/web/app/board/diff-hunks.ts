export interface DiffHunk {
  header: string;
  /** Leading unchanged (space-prefixed) lines before the first +/- change in this hunk. */
  leadingContext: string[];
  /** Everything from the first +/- change onward. */
  rest: string[];
}

// Splits a real unified diff (as returned by getCardDiff) into hunks so the
// leading unchanged context of each one can be collapsed behind a toggle --
// a view over the real diff text, not a derived metric.
export function parseDiffHunks(diff: string): DiffHunk[] {
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { header: line, leadingContext: [], rest: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // file header lines (diff --git, ---, +++) before the first hunk
    const isChange = line.startsWith("+") || line.startsWith("-");
    if (!isChange && current.rest.length === 0) {
      current.leadingContext.push(line);
    } else {
      current.rest.push(line);
    }
  }

  return hunks;
}
