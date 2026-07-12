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

// Matches the "resets 1:40am (Asia/Kolkata)" clause in the real CLI message
// above -- a daily wall-clock moment, never a date, since the message never
// says which day it means.
const RESET_TIME_PATTERN = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i;

function timeZonePartsAt(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// Resolves "hh:mm in timeZone, on this (year, month, day)" to the UTC instant
// it names. A plain Date.UTC(...) guess is off by whatever timeZone's offset
// is at that moment; one correction pass against Intl's own read of that
// guess is exact except in the instant of a DST transition, which is an
// acceptable gap for a retry-scheduling heuristic.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(guess - (asIfUtc - guess));
}

// Parses the real reset instant out of the CLI's rate-limit message, instead
// of the caller guessing at a fixed backoff -- see loop.ts's
// RATE_LIMIT_BACKOFF_MS comment for why a fixed 20-minute retry against an
// account that resets hours from now just burns another attempt into the
// same wall. Returns the next occurrence of that wall-clock time on or after
// referenceTime (today's if still ahead, otherwise tomorrow's), or null if
// the text doesn't contain a recognizable "resets HH:MM(am|pm) (Zone)"
// clause -- callers fall back to a fixed backoff in that case.
export function parseRateLimitResetAt(resultText: string, referenceTime: Date = new Date()): Date | null {
  const match = resultText.match(RESET_TIME_PATTERN);
  if (!match) return null;
  const [, hourStr, minuteStr, meridiem, timeZone] = match;

  let hour = Number(hourStr) % 12;
  if (meridiem?.toLowerCase() === "pm") hour += 12;
  const minute = Number(minuteStr);

  let today: { year: number; month: number; day: number };
  try {
    today = timeZonePartsAt(referenceTime, timeZone!);
  } catch {
    return null; // timeZone wasn't a real IANA name -- don't guess
  }

  let target = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone!);
  if (target.getTime() <= referenceTime.getTime()) {
    target = zonedTimeToUtc(today.year, today.month, today.day + 1, hour, minute, timeZone!);
  }
  return target;
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
