// Turns a full implementer-crash dump or reviewer rejection transcript (which
// can run to thousands of characters) into a short note injected into the
// next retry's prompt (see prompts.ts's "## Previous attempt feedback"
// section). RFC: rfc/2026-07-obsidian-vault-token-efficiency — retries no
// longer pay the full previous-attempt transcript on every subsequent turn.
const MAX_NOTE_LINES = 10;
const MAX_LINE_LENGTH = 300;

export type FailureKind = "implementer_error" | "review_rejected";

// The Claude CLI's own rate/session-limit message ("You've hit your session
// limit · resets 1:40am (Asia/Kolkata)") is a real, observed error shape,
// distinct from every other failure this platform retries: nothing about
// the card's work is wrong, the account just can't make another call yet.
// Both call sites that check this treat it specially -- not counted against
// MAX_ATTEMPTS, scheduled for a later automatic retry instead of blocking
// for a human. Reviewer verdicts fail closed on any CLI error (see
// runReviewerAgent's comment) specifically so a broken run can never wave a
// card through, which means a rate-limited reviewer call reads exactly like
// a genuine rejection unless this is checked first.
const RATE_LIMIT_MARKERS = ["session limit", "rate limit", "usage limit"];

export function isRateLimitError(resultText: string): boolean {
  const lower = resultText.toLowerCase();
  return RATE_LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

export function distillFailureNote(kind: FailureKind, resultText: string): string {
  const header = kind === "implementer_error" ? "Implementer run failed." : "Reviewer rejected the previous attempt.";

  const lines = resultText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const criterionFailures = lines.filter((l) => /^CRITERION:.*->\s*NOT SATISFIED/i.test(l));
  const verdictLine = lines.find((l) => /^VERDICT:/i.test(l));

  const maxBodyLines = MAX_NOTE_LINES - 1; // header takes one of the 10 lines
  const body: string[] = criterionFailures.length
    ? criterionFailures.slice(0, maxBodyLines)
    : lines.slice(-maxBodyLines);

  if (verdictLine && !body.includes(verdictLine) && body.length < maxBodyLines) {
    body.push(verdictLine);
  }

  return [header, ...body.slice(0, maxBodyLines)].map(truncateLine).join("\n");
}
