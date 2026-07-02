import { z } from "zod";
import {
  AGENT_RUN_STATUSES,
  CARD_DEPENDENCY_TYPES,
  CARD_DOC_LINK_TYPES,
  CARD_STATES,
  CARD_TYPES,
  DEPLOY_STATUSES,
  DOC_STATUSES,
  DOC_TYPES,
  GATE_RESULT_STATUSES,
  RISK_TIERS,
  USER_ROLES,
  WORKTREE_STATUSES,
} from "./enums";

const uuid = z.string().uuid();
const isoDate = z.coerce.date();

export const UserSchema = z.object({
  id: uuid,
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(USER_ROLES).default("member"),
  createdAt: isoDate,
});
export type User = z.infer<typeof UserSchema>;

export const DocSchema = z.object({
  id: uuid,
  slug: z.string().min(1),
  title: z.string().min(1),
  docType: z.enum(DOC_TYPES),
  repoPath: z.string().min(1),
  latestCommitSha: z.string().nullable(),
  status: z.enum(DOC_STATUSES).default("draft"),
  tags: z.array(z.string()).default([]),
  createdBy: uuid.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Doc = z.infer<typeof DocSchema>;

export const DocCreateInputSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  docType: z.enum(DOC_TYPES),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  authorId: uuid.optional(),
  message: z.string().min(1).default("create doc"),
});
export type DocCreateInput = z.infer<typeof DocCreateInputSchema>;

export const DocUpdateInputSchema = z.object({
  content: z.string(),
  authorId: uuid.optional(),
  message: z.string().min(1).default("update doc"),
  status: z.enum(DOC_STATUSES).optional(),
});
export type DocUpdateInput = z.infer<typeof DocUpdateInputSchema>;

export const AdrSchema = z.object({
  docId: uuid,
  adrNumber: z.number().int().positive(),
  decisionSummary: z.string().nullable(),
  supersedesDocId: uuid.nullable(),
});
export type Adr = z.infer<typeof AdrSchema>;

export const SkillSchema = z.object({
  docId: uuid,
  applicabilityTags: z.array(z.string()).default([]),
  lastVerifiedAt: isoDate.nullable(),
  sourceCardId: uuid.nullable(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const BoardSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: isoDate,
});
export type Board = z.infer<typeof BoardSchema>;

export const CardSchema = z.object({
  id: uuid,
  boardId: uuid,
  title: z.string().min(1),
  description: z.string().nullable(),
  cardType: z.enum(CARD_TYPES).default("feature"),
  state: z.enum(CARD_STATES).default("backlog"),
  riskTier: z.enum(RISK_TIERS).default("low"),
  touchesArchitecture: z.boolean().default(false),
  priority: z.number().int().default(3),
  tags: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  assigneeId: uuid.nullable(),
  agentRoleId: uuid.nullable(),
  worktreeId: uuid.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Card = z.infer<typeof CardSchema>;

export const CardCreateInputSchema = z.object({
  boardId: uuid,
  title: z.string().min(1),
  description: z.string().optional(),
  cardType: z.enum(CARD_TYPES).default("feature"),
  riskTier: z.enum(RISK_TIERS).default("low"),
  priority: z.number().int().default(3),
  tags: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  assigneeId: uuid.optional(),
});
export type CardCreateInput = z.infer<typeof CardCreateInputSchema>;

export const CardUpdateInputSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable(),
    cardType: z.enum(CARD_TYPES),
    riskTier: z.enum(RISK_TIERS),
    priority: z.number().int(),
    tags: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    assigneeId: uuid.nullable(),
  })
  .partial()
  .refine((input) => Object.keys(input).length > 0, {
    message: "at least one field must be provided",
  });
export type CardUpdateInput = z.infer<typeof CardUpdateInputSchema>;

// Computed (not persisted) status explainability attached to a card by the
// board-engine package when listing cards for the UI — see
// packages/board-engine/src/card-status.ts. Plain interfaces (no zod) since
// nothing ever needs to parse/validate these off the wire independently of
// the Card they're attached to.
export interface CardActiveRun {
  roleName: string | null;
  status: "running" | "verifying";
}

export interface CardWithStatus extends Card {
  /** One-line reason a blocked card is blocked, e.g. "security_scan failed". Null if not blocked. */
  blockedReason: string | null;
  /** Set when an agent is actively working the card, so the tile can show a live indicator. */
  activeAgentRun: CardActiveRun | null;
}

export const IntakeInputSchema = z.object({
  boardId: uuid,
  requestText: z.string().min(1),
  requestedById: uuid.optional(),
});
export type IntakeInput = z.infer<typeof IntakeInputSchema>;

export const CardTransitionInputSchema = z.object({
  toState: z.enum(CARD_STATES),
  actorType: z.enum(["user", "agent", "automation"]).default("user"),
  actorId: uuid.optional(),
});
export type CardTransitionInput = z.infer<typeof CardTransitionInputSchema>;

export const CardDocLinkSchema = z.object({
  cardId: uuid,
  docId: uuid,
  linkType: z.enum(CARD_DOC_LINK_TYPES),
});
export type CardDocLink = z.infer<typeof CardDocLinkSchema>;

export const CardDependencySchema = z.object({
  cardId: uuid,
  dependsOnCardId: uuid,
  dependencyType: z.enum(CARD_DEPENDENCY_TYPES).default("blocks"),
});
export type CardDependency = z.infer<typeof CardDependencySchema>;

export const AgentRoleSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  description: z.string().nullable(),
  capabilities: z.array(z.string()).default([]),
  modelConfig: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentRunSchema = z.object({
  id: uuid,
  cardId: uuid.nullable(),
  agentRoleId: uuid.nullable(),
  worktreeId: uuid.nullable(),
  status: z.enum(AGENT_RUN_STATUSES).default("queued"),
  verdict: z.enum(["pass", "fail"]).nullable(),
  logsRef: z.string().nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const WorktreeSchema = z.object({
  id: uuid,
  cardId: uuid,
  repoUrl: z.string(),
  branchName: z.string(),
  fsPath: z.string(),
  baseCommitSha: z.string(),
  status: z.enum(WORKTREE_STATUSES).default("creating"),
  createdAt: isoDate,
  tornDownAt: isoDate.nullable(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const GateDefinitionSchema = z.object({
  id: uuid,
  key: z.string().min(1),
  name: z.string().min(1),
  blocking: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type GateDefinition = z.infer<typeof GateDefinitionSchema>;

export const GateResultSchema = z.object({
  id: uuid,
  cardId: uuid,
  gateDefinitionId: uuid,
  status: z.enum(GATE_RESULT_STATUSES),
  runByAgentRunId: uuid.nullable(),
  runByUserId: uuid.nullable(),
  detail: z.record(z.unknown()).default({}),
  createdAt: isoDate,
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const DeployRecordSchema = z.object({
  id: uuid,
  cardId: uuid,
  environment: z.string().default("production"),
  status: z.enum(DEPLOY_STATUSES).default("pending"),
  deployedCommitSha: z.string().nullable(),
  deployUrl: z.string().nullable(),
  monitoringDashboardUrl: z.string().nullable(),
  rollbackOfDeployId: uuid.nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
});
export type DeployRecord = z.infer<typeof DeployRecordSchema>;

export const EventLogEntrySchema = z.object({
  id: z.number().int(),
  entityType: z.enum(["card", "doc", "worktree", "gate_result", "deploy_record"]),
  entityId: uuid,
  eventType: z.string().min(1),
  actorType: z.enum(["user", "agent", "automation"]),
  actorId: uuid.nullable(),
  payload: z.record(z.unknown()).default({}),
  createdAt: isoDate,
});
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
