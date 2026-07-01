import { db, pool } from "./client.js";
import { agentRoles, boards, cards, gateDefinitions } from "./schema.js";

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
  ]);

  await db.insert(gateDefinitions).values([
    { key: "tests_ci", name: "Tests pass + CI green", blocking: true },
    { key: "security_scan", name: "Security review cleared", blocking: true },
    { key: "docs_adr_linked", name: "Spec doc linked", blocking: true },
    { key: "adr_required", name: "ADR linked if architecture touched", blocking: true },
    { key: "peer_review", name: "Sub-agent peer review passed", blocking: true },
    { key: "deploy_live", name: "Deployed with monitoring wired", blocking: true },
  ]);

  await pool.end();
  console.log(`seeded board ${board.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
