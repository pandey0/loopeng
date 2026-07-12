import { db, pool } from "./client.js";
import { agentRoles, automations, boards, cards, gateDefinitions } from "./schema.js";

async function main() {
  const [board] = await db
    .insert(boards)
    .values({ name: "LoopEng Platform", description: "Dogfood board for building this platform" })
    .returning();
  if (!board) throw new Error("failed to seed board");

  await db.insert(cards).values([
    {
      boardId: board.id,
      title: "Set up doc engine git repo",
      description: "Initialize data/wiki-repo with adr/rfc/skills/wiki directories",
      cardType: "chore",
      state: "backlog",
      priority: 1,
    },
    {
      boardId: board.id,
      title: "Write first ADR: use Drizzle over Prisma",
      description: "Document the ORM decision as an ADR",
      cardType: "chore",
      state: "backlog",
      priority: 2,
    },
    {
      boardId: board.id,
      title: "Kanban drag-and-drop UI",
      description: "Board page with columns matching card state machine",
      cardType: "feature",
      state: "ready",
      priority: 1,
    },
  ]);

  // Agent roles and gate definitions are scaffolded now (Phase 2/3 features)
  // so downstream tables have stable rows to reference once those phases land.
  await db.insert(agentRoles).values([
    { name: "implementer", description: "Picks up ready cards and writes code in an isolated worktree", capabilities: ["code"] },
    { name: "reviewer", description: "Sub-agent verification of implementer output before gates run", capabilities: ["review"] },
    { name: "triager", description: "Scans backlog/board on a schedule and prepares cards", capabilities: ["triage"] },
    { name: "doc-scanner", description: "Detects doc/code drift", capabilities: ["docs"] },
    {
      name: "planner",
      description: "Turns a freeform product-owner request into a spec doc plus epic/feature/bug cards, ready for auto-pickup",
      capabilities: ["planning"],
    },
    {
      name: "tech-manager",
      description: "Reviews a freshly-decomposed epic's child cards and may adjust the breakdown; escalation target for QUESTION:s from its cards",
      capabilities: ["management"],
    },
    {
      name: "designer",
      description:
        "Engages UI/UX-touching cards at two points: an upstream design spec before the implementer starts, and a downstream design review parallel to code review",
      capabilities: ["design"],
    },
    {
      name: "integrator",
      description:
        "Resolves a git rebase conflict inside a card's own worktree when its branch is synced onto the base branch before deploy, so trunk never sees an unresolved merge",
      capabilities: ["integration"],
    },
    {
      name: "analyzer",
      description:
        "Runs once, read-only, right after a project is registered — explores the repo and writes a project-brief doc (stack, architecture, key directories, conventions) that every later agent on that project gets as automatic context",
      capabilities: ["analysis"],
    },
  ]);

  // Names describe what each gate checks, not an outcome -- the UI renders
  // this text next to a separate pass/fail StatusBadge, so a name phrased as
  // an assertion of success ("Designer review passed") reads as a
  // contradiction sitting right next to a red "failed" badge on the exact
  // gate that failed. design_review is blocking: false because it's
  // advisory-only in v1 (see orchestrator/loop.ts's recordDesignReviewGate
  // call site) -- it never actually gates the card, so claiming blocking:
  // true here was itself misleading independent of the name issue.
  await db.insert(gateDefinitions).values([
    { key: "tests_ci", name: "Tests + CI", blocking: true },
    { key: "ci_status", name: "CI checks", blocking: true },
    { key: "security_scan", name: "Security scan", blocking: true },
    { key: "docs_adr_linked", name: "Spec doc link", blocking: true },
    { key: "adr_required", name: "ADR link (if architecture touched)", blocking: true },
    { key: "peer_review", name: "Peer review", blocking: true },
    { key: "design_review", name: "Design review", blocking: false },
    { key: "deploy_live", name: "Deploy + monitoring", blocking: true },
    { key: "repo_valid", name: "Repo valid", blocking: true },
  ]);

  await db.insert(automations).values([
    {
      name: "morning triage",
      triggerType: "cron",
      scheduleCron: "0 9 * * *",
      target: { boardId: board.id },
      action: { type: "triage_scan" },
    },
    {
      // Single row covers both card.moved -> ready (agent loop dispatch)
      // and card.moved -> deploying (deploy pipeline dispatch) — the
      // event-trigger branches on the transition's target state itself.
      name: "dispatch on ready/deploying",
      triggerType: "event",
      eventType: "card.state_changed",
      target: { boardId: board.id },
      action: { type: "triage_scan" },
    },
    {
      name: "nightly doc drift scan",
      triggerType: "cron",
      scheduleCron: "0 2 * * *",
      target: { boardId: board.id },
      action: { type: "doc_drift_scan" },
    },
  ]);

  await pool.end();
  console.log(`seeded board ${board.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
