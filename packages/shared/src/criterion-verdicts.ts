// Parses the reviewer's own per-criterion checklist out of its transcript
// text ("CRITERION: <the exact criterion text> -> SATISFIED", see
// buildReviewerPrompt in @loopeng/agents, which instructs the reviewer to
// echo each acceptance-criteria item verbatim before its verdict). Pure and
// dependency-free so both the api (persisting nothing extra -- this reads
// straight off gate_results.detail.resultText, already stored) and the web
// app (rendering it) can use the exact same parsing rules.
//
// Card detail previously showed every acceptance criterion with the same
// static checkmark regardless of whether anything had actually verified
// it. This is what makes that checkmark mean something real: which run
// said SATISFIED, not just "a criterion exists."
export interface CriterionVerdict {
  criterion: string;
  satisfied: boolean;
}

const CRITERION_LINE = /^CRITERION:\s*(.+?)\s*->\s*(SATISFIED|NOT SATISFIED)\s*$/i;

export function parseCriterionVerdicts(resultText: string): CriterionVerdict[] {
  const verdicts: CriterionVerdict[] = [];
  for (const rawLine of resultText.split("\n")) {
    const match = rawLine.trim().match(CRITERION_LINE);
    if (!match) continue;
    verdicts.push({ criterion: match[1]!.trim(), satisfied: match[2]!.toUpperCase() === "SATISFIED" });
  }
  return verdicts;
}

// Matches a card's own acceptance-criteria strings against the reviewer's
// parsed verdicts by exact text -- the prompt asks for verbatim echo
// specifically so this match is reliable. A criterion with no matching
// CRITERION line (reviewer skipped it, or ran before this criterion was
// added to the card) is neither true nor false -- null, rendered as "not
// yet verified" rather than defaulting to either a false pass or a false
// failure.
export function matchCriterionVerdicts(
  acceptanceCriteria: string[],
  verdicts: CriterionVerdict[],
): { criterion: string; satisfied: boolean | null }[] {
  const byText = new Map(verdicts.map((v) => [v.criterion, v.satisfied]));
  return acceptanceCriteria.map((criterion) => ({
    criterion,
    satisfied: byText.has(criterion) ? byText.get(criterion)! : null,
  }));
}
