export const CARD_STATES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "gate_checks",
  "awaiting_approval",
  "deploying",
  "done",
  "blocked",
  "cancelled",
] as const;
export type CardState = (typeof CARD_STATES)[number];

export const CARD_TYPES = ["epic", "feature", "bug", "chore", "spike"] as const;
export type CardType = (typeof CARD_TYPES)[number];

// Decomposition output of the planner agent never assigns "epic" to a leaf
// card — epic is reserved for the single parent card it drafts per intake
// request, so gate/agent pickup logic never tries to "implement" an epic.
// Kept as its own literal tuple (not CARD_TYPES.filter(...)) so zod's
// z.enum(), which requires a readonly non-empty tuple type, can consume it.
export const PLANNER_CHILD_CARD_TYPES = ["feature", "bug", "chore", "spike"] as const satisfies readonly Exclude<
  CardType,
  "epic"
>[];

export const RISK_TIERS = ["low", "medium", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const DOC_TYPES = ["wiki", "adr", "rfc", "skill"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATUSES = [
  "draft",
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const CARD_DOC_LINK_TYPES = ["spec", "adr", "skill", "related"] as const;
export type CardDocLinkType = (typeof CARD_DOC_LINK_TYPES)[number];

export const CARD_DEPENDENCY_TYPES = ["blocks", "relates_to"] as const;
export type CardDependencyType = (typeof CARD_DEPENDENCY_TYPES)[number];

export const GATE_RESULT_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
] as const;
export type GateResultStatus = (typeof GATE_RESULT_STATUSES)[number];

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "verifying",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const WORKTREE_STATUSES = [
  "creating",
  "active",
  "merged",
  "torn_down",
  "failed",
] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export const DEPLOY_STATUSES = [
  "pending",
  "deploying",
  "live",
  "rolled_back",
  "failed",
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const USER_ROLES = ["admin", "member", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CARD_QUESTION_STATUSES = ["open", "answered"] as const;
export type CardQuestionStatus = (typeof CARD_QUESTION_STATUSES)[number];
