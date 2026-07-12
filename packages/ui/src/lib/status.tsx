import type { SVGProps } from "react";
import type { CardState, DeployStatus, GateResultStatus } from "@loopeng/shared";

// Every status-bearing entity in the system (card, gate result, deploy record)
// funnels through this single map so a color/icon/label never has to be
// re-invented per component. Keys are the union of all three domains' status
// strings; where a literal string means the same thing in two domains
// (e.g. "deploying", "pending", "failed") it intentionally shares one entry.
export type StatusKey = CardState | GateResultStatus | DeployStatus;

export type StatusTone = "neutral" | "info" | "success" | "warning" | "destructive";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Tailwind classes for a small colored dot/swatch. */
  dotClassName: string;
  /** Tailwind text-color class matching the same tone, for bare icons/text. */
  textClassName: string;
  /** Variant to pass straight into the shared Badge component. */
  badgeVariant: "default" | "secondary" | "destructive" | "success" | "warning" | "outline";
  Icon: (props: SVGProps<SVGSVGElement>) => JSX.Element;
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function CrossIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function SpinnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M8 2a6 6 0 1 1-6 6" />
    </svg>
  );
}

function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  );
}

function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <rect x="4" y="3" width="3" height="10" rx="0.5" />
      <rect x="9" y="3" width="3" height="10" rx="0.5" />
    </svg>
  );
}

function DashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...props}>
      <path d="M4 8h8" />
    </svg>
  );
}

function EyeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
      <circle cx="8" cy="8" r="1.75" />
    </svg>
  );
}

const TONE_DOT_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const TONE_TEXT_CLASS: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

const TONE_BADGE_VARIANT: Record<StatusTone, StatusMeta["badgeVariant"]> = {
  neutral: "secondary",
  info: "default",
  success: "success",
  warning: "warning",
  destructive: "destructive",
};

function meta(label: string, tone: StatusTone, Icon: StatusMeta["Icon"]): StatusMeta {
  return {
    label,
    tone,
    Icon,
    dotClassName: TONE_DOT_CLASS[tone],
    textClassName: TONE_TEXT_CLASS[tone],
    badgeVariant: TONE_BADGE_VARIANT[tone],
  };
}

export const STATUS_META: Record<StatusKey, StatusMeta> = {
  // CardState
  backlog: meta("Backlog", "neutral", ClockIcon),
  ready: meta("Ready", "neutral", DashIcon),
  in_progress: meta("In Progress", "info", SpinnerIcon),
  in_review: meta("In Review", "info", EyeIcon),
  gate_checks: meta("Gate Checks", "info", SpinnerIcon),
  awaiting_approval: meta("Awaiting Approval", "warning", PauseIcon),
  deploying: meta("Deploying", "info", SpinnerIcon),
  deploy_failed: meta("Deploy Failed", "destructive", CrossIcon),
  done: meta("Done", "success", CheckIcon),
  blocked: meta("Blocked", "destructive", CrossIcon),
  cancelled: meta("Cancelled", "neutral", CrossIcon),
  // GateResultStatus (pending/failed shared with DeployStatus below)
  pending: meta("Pending", "neutral", ClockIcon),
  running: meta("Running", "info", SpinnerIcon),
  passed: meta("Passed", "success", CheckIcon),
  failed: meta("Failed", "destructive", CrossIcon),
  skipped: meta("Skipped", "neutral", DashIcon),
  // DeployStatus (pending/deploying/failed shared above)
  live: meta("Live", "success", CheckIcon),
  rolled_back: meta("Rolled Back", "warning", CrossIcon),
  crashed: meta("Crashed", "destructive", CrossIcon),
};

export function getStatusMeta(key: StatusKey): StatusMeta {
  return STATUS_META[key] ?? meta(key, "neutral", DashIcon);
}
