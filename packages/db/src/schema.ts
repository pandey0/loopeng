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
  // One-line frontmatter summary, mirrored from the git file so callers building
  // agent prompts can list every linked doc's summary without a git read per doc
  // (see doc-engine's createDoc/updateDoc, which is the only writer of this column).
  summary: text("summary").notNull().default(""),
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

// ===== Projects (multi-project onboarding) =====
// One row per onboarded target repo. A board is optionally scoped to a
// project via boards.project_id -- nullable so the single dogfood board that
// predates this feature keeps working unmigrated (its cards resolve their
// target repo via the TARGET_REPO_PATH env fallback, same as before this
// table existed). See ADR "multi-project-onboarding".
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Absolute local filesystem path to the target repo's root (must contain
  // .git -- validated at registration time and re-validated on every
  // dispatch, since the directory can be deleted/moved after registration).
  // For a GitHub-cloned project this is the managed clone destination, not
  // wherever the user's own checkout happens to live.
  repoPath: text("repo_path").notNull(),
  // Set only when onboarded via "clone from GitHub" (POST /projects with
  // repoUrl) -- null for a project registered against an already-local path.
  repoUrl: text("repo_url"),
  // The analyzer agent's output: a project-brief doc every later agent on
  // this project's cards gets prepended to its spec-docs context, same as a
  // linked spec doc. Null until the analyzer finishes (see briefStatus).
  briefDocId: uuid("brief_doc_id").references(() => docs.id),
  briefStatus: text("brief_status").notNull().default("pending"), // pending|analyzing|ready|failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ===== Board engine =====
export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cards = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  boardId: uuid("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  cardType: text("card_type").notNull().default("feature"), // epic|feature|bug|chore|spike
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

// Structured, turn-based Q&A: an agent ends its turn with QUESTION: <text>
// instead of guessing or failing, the card pauses blocked, a human answers
// via the API, and the answer is injected into the next dispatch's prompt.
export const cardQuestions = pgTable("card_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  agentRunId: uuid("agent_run_id").references((): AnyPgColumn => agentRuns.id),
  roleName: text("role_name").notNull(),
  question: text("question").notNull(),
  status: text("status").notNull().default("open"), // open | answered
  // No manager tier exists yet, so v1 always routes to the product owner.
  routedTo: text("routed_to").notNull().default("product_owner"),
  answer: text("answer"),
  answeredBy: text("answered_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
});

// ===== Agents (Phase 2+, tables scaffolded now for FK stability) =====
export const agentRoles = pgTable("agent_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(), // 'implementer' | 'reviewer' | 'triager' | 'doc-scanner' | 'planner'
  description: text("description"),
  capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
  modelConfig: jsonb("model_config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
  // Set only for project-scoped runs that have no card (currently: the
  // analyzer). Lets the UI look up "the latest brain-build run for project
  // X" -- without this, that run is an orphaned row nothing can query by
  // project, and the frontend has no way to attach a live session view to it.
  // Cascades like cardId above -- an agent run tied to a deleted project is
  // meaningless data, not something a project delete should be blocked by.
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  // Set only for planner runs (a planning conversation has no card yet --
  // that's what it produces). Lets a board's planning history be listed and
  // revisited: GET /boards/:id/intake queries agent_runs by boardId, and
  // every session's transcript is already durable (agent_runs.transcript),
  // so the conversation survives a page reload/navigation away.
  boardId: uuid("board_id").references((): AnyPgColumn => boards.id, { onDelete: "cascade" }),
  agentRoleId: uuid("agent_role_id").references(() => agentRoles.id),
  worktreeId: uuid("worktree_id").references((): AnyPgColumn => worktrees.id),
  parentAgentRunId: uuid("parent_agent_run_id").references((): AnyPgColumn => agentRuns.id),
  status: text("status").notNull().default("queued"), // queued|running|awaiting_approval|succeeded|failed|verifying
  verdict: text("verdict"), // pass | fail (sub-agent verification runs)
  logsRef: text("logs_ref"),
  // Incrementally-appended stream-json events for interactive sessions (card A+).
  // Empty for one-shot runClaudeCli runs, which only ever populate the final result.
  transcript: jsonb("transcript").notNull().default([]),
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
  status: text("status").notNull().default("pending"), // pending|deploying|live|rolled_back|failed|crashed
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

// ===== API keys — verified caller identity for actorType attribution =====
// One row per issued credential. tokenHash is sha256(raw token); the raw
// token is only ever shown once (at mint time) and never stored. actorId is
// polymorphic like event_log.actor_id above (no FK): for actorType='agent'
// it's the agent_runs.id the key was scoped to; for actorType='user' it's
// null (the web UI's single static bootstrap key -- see ensureStaticApiKey).
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  actorType: text("actor_type").notNull(), // user | agent | automation
  actorId: uuid("actor_id"),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set once (never un-set) so a key can be permanently retired -- e.g. when
  // the agent run it was scoped to finishes -- without deleting the row and
  // losing the audit trail of what that key was ever allowed to do.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
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
