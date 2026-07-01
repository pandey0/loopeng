import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ===== Users =====
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull().default("member"), // admin | member | viewer
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ===== Doc engine =====
export const docs = pgTable("docs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  docType: text("doc_type").notNull(), // wiki | adr | rfc | skill
  repoPath: text("repo_path").notNull(),
  latestCommitSha: text("latest_commit_sha"),
  status: text("status").notNull().default("draft"), // draft|proposed|accepted|superseded|deprecated
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Cached index of git history — derived, rebuildable from git log, not authoritative
export const docVersions = pgTable("doc_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  docId: uuid("doc_id")
    .notNull()
    .references(() => docs.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  authorId: uuid("author_id").references(() => users.id),
  authorAgentRunId: uuid("author_agent_run_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// ADR-specific structured metadata (1:1 with docs where doc_type='adr')
export const adrs = pgTable("adrs", {
  docId: uuid("doc_id")
    .primaryKey()
    .references(() => docs.id, { onDelete: "cascade" }),
  adrNumber: integer("adr_number").notNull(),
  decisionSummary: text("decision_summary"),
  supersedesDocId: uuid("supersedes_doc_id").references((): AnyPgColumn => docs.id),
});

// Skill metadata (1:1 with docs where doc_type='skill')
export const skills = pgTable("skills", {
  docId: uuid("doc_id")
    .primaryKey()
    .references(() => docs.id, { onDelete: "cascade" }),
  applicabilityTags: text("applicability_tags").array().notNull().default(sql`'{}'::text[]`),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  sourceCardId: uuid("source_card_id").references((): AnyPgColumn => cards.id),
});

// ===== Board engine =====
export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cards = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  boardId: uuid("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  cardType: text("card_type").notNull().default("feature"), // feature|bug|chore|spike
  state: text("state").notNull().default("backlog"),
  riskTier: text("risk_tier").notNull().default("low"), // low|medium|high
  touchesArchitecture: boolean("touches_architecture").notNull().default(false),
  priority: integer("priority").notNull().default(3),
  // Matched against docs.tags (array overlap) so agents auto-load relevant
  // Skill docs before a run instead of re-deriving context every time.
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  acceptanceCriteria: text("acceptance_criteria").array().notNull().default(sql`'{}'::text[]`),
  assigneeId: uuid("assignee_id").references(() => users.id),
  agentRoleId: uuid("agent_role_id").references((): AnyPgColumn => agentRoles.id),
  worktreeId: uuid("worktree_id").references((): AnyPgColumn => worktrees.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cardDocLinks = pgTable(
  "card_doc_links",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    docId: uuid("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull(), // spec | adr | skill | related
  },
  (table) => [primaryKey({ columns: [table.cardId, table.docId, table.linkType] })],
);

export const cardDependencies = pgTable(
  "card_dependencies",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    dependsOnCardId: uuid("depends_on_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    dependencyType: text("dependency_type").notNull().default("blocks"), // blocks | relates_to
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.dependsOnCardId] }),
    check("no_self_dependency", sql`${table.cardId} <> ${table.dependsOnCardId}`),
  ],
);

// ===== Agents (Phase 2+, tables scaffolded now for FK stability) =====
export const agentRoles = pgTable("agent_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // 'implementer' | 'reviewer' | 'triager' | 'doc-scanner'
  description: text("description"),
  capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
  modelConfig: jsonb("model_config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
  agentRoleId: uuid("agent_role_id").references(() => agentRoles.id),
  worktreeId: uuid("worktree_id").references((): AnyPgColumn => worktrees.id),
  status: text("status").notNull().default("queued"), // queued|running|succeeded|failed|verifying
  verdict: text("verdict"), // pass | fail (sub-agent verification runs)
  logsRef: text("logs_ref"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ===== Worktrees =====
export const worktrees = pgTable("worktrees", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  repoUrl: text("repo_url").notNull(),
  branchName: text("branch_name").notNull(),
  fsPath: text("fs_path").notNull(),
  baseCommitSha: text("base_commit_sha").notNull(),
  status: text("status").notNull().default("creating"), // creating|active|merged|torn_down|failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tornDownAt: timestamp("torn_down_at", { withTimezone: true }),
});

// ===== Gate pipeline (Phase 3, tables scaffolded now) =====
export const gateDefinitions = pgTable("gate_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(), // 'tests_ci' | 'security_scan' | 'docs_adr_linked' | 'deploy_live'
  name: text("name").notNull(),
  blocking: boolean("blocking").notNull().default(true),
  config: jsonb("config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
});

// append-only: never UPDATE, always INSERT a new row for re-runs
export const gateResults = pgTable("gate_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  gateDefinitionId: uuid("gate_definition_id")
    .notNull()
    .references(() => gateDefinitions.id),
  status: text("status").notNull(), // pending|running|passed|failed|skipped
  runByAgentRunId: uuid("run_by_agent_run_id").references(() => agentRuns.id),
  runByUserId: uuid("run_by_user_id").references(() => users.id),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ===== Deploy (Phase 4, scaffolded now) =====
export const deployRecords = pgTable("deploy_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  environment: text("environment").notNull().default("production"),
  status: text("status").notNull().default("pending"), // pending|deploying|live|rolled_back|failed
  deployedCommitSha: text("deployed_commit_sha"),
  deployUrl: text("deploy_url"),
  monitoringDashboardUrl: text("monitoring_dashboard_url"),
  rollbackOfDeployId: uuid("rollback_of_deploy_id").references(
    (): AnyPgColumn => deployRecords.id,
  ),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ===== Automations & Connectors (Phase 2/3, scaffolded now) =====
export const automations = pgTable("automations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(), // cron | event | webhook
  scheduleCron: text("schedule_cron"),
  eventType: text("event_type"), // 'card.state_changed', 'gate.failed', ...
  target: jsonb("target").notNull().default({}), // {board_id} or query filter
  action: jsonb("action").notNull().default({}), // {type: 'triage_scan' | 'doc_drift_scan' | ...}
  enabled: boolean("enabled").notNull().default(true),
});

export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  automationId: uuid("automation_id")
    .notNull()
    .references(() => automations.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"),
  result: jsonb("result").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // github | slack | linear
  config: jsonb("config").notNull().default({}), // non-secret config; secrets referenced by env var name
  enabled: boolean("enabled").notNull().default(true),
});

// ===== Event log — the loop-engineering "memory" substrate =====
export const eventLog = pgTable("event_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityType: text("entity_type").notNull(), // card|doc|worktree|gate_result|deploy_record
  entityId: uuid("entity_id").notNull(),
  eventType: text("event_type").notNull(), // 'card.moved', 'doc.committed', 'gate.failed', ...
  actorType: text("actor_type").notNull(), // user|agent|automation
  actorId: uuid("actor_id"),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
