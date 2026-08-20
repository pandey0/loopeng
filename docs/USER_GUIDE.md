# Loopeng User Guide: How This Platform Actually Works

This is the practical, end-to-end guide to using Loopeng — the self-hosted internal developer platform that combines a Confluence-style docs wiki, a Kanban dev-cycle board, and real AI coding agents that do the actual implementation work per card. Everything below reflects the real, currently-shipped behavior of the system (not aspirational design) and is written around realistic production scenarios rather than abstract feature lists.

## 1. Getting started: onboarding a project

Before there's a board to work on, there's a project. Land on `/projects` — the platform's home, deliberately shown without the board-scoped sidebar/top bar, since none of that (Board/Docs/Activity/Inbox, the board switcher) makes sense before you've picked one. Click "+ Clone repository": either point at a repo already on this machine (**Local path**) or give it a URL (**Clone from GitHub**, cloned server-side into a managed directory). Either way, the project and its board are created in the same request and you land on `/board` immediately.

In the background, an **analyzer** agent — read-only, no card or worktree involved — explores the freshly-registered repo and writes a **project brief**: stack, architecture, entry points, conventions, how to build/test/run. `/projects` shows this building live (`Building brain…` → `🧠 Brain ready`, with a `↻ Re-analyze` to refresh it on demand — it's a snapshot, not something that tracks the repo automatically). From then on, every implementer/reviewer/manager/designer/planner run on that project's cards gets this brief prepended to its context automatically, the same way a linked spec doc does — agents start with real knowledge of your codebase instead of exploring from scratch every time.

Before any card can actually get worked, check `/settings` — two real, workspace-wide checks: GitHub (`GITHUB_TOKEN`/`GITHUB_REPO`, only needed for PR-comment features; the actual git commits/merges agents make don't need it, they're plain local `git`) and the Claude Code CLI (whether the api server can run `claude` at all). Both need to be green.

## 2. The mental model

Forget "ticket tracker." Think of a **card** as a unit of work that an **AI agent will actually implement**, not just track. When you move a card to `ready`, a real `claude` CLI process starts working in an isolated git worktree — reading your codebase, writing code, running tests, committing — the same way a human engineer would, except headless and on your schedule.

The three pillars:

- **Board** — Kanban columns representing the actual pipeline a change goes through: intake → implementation → review → automated gates → human approval → deploy.
- **Docs** — a wiki (specs, ADRs, RFCs, skills) that agents read before working and write to as part of their output. This is how institutional knowledge accumulates instead of living only in Slack threads.
- **Agents** — role-scoped `claude` CLI processes (planner, implementer, reviewer, tech-manager, designer, integrator, analyzer, triager, doc-scanner) that do the real work, live-streamed so you can watch them think.

## 3. The card lifecycle (the thing you'll see most)

```
backlog -> ready -> in_progress -> in_review -> gate_checks -> awaiting_approval -> deploying -> done
                                                      |
                                                      v (auto for low/medium risk)
                                                  deploying -> done
                                       blocked <-------+ (escape hatch from any stuck stage)
```

**Real example: "Add rate limiting to the public API"**

1. **Intake, as a conversation.** You click "New" (or the "Plan" 💬 link in the sidebar) and land on `/plan` — a dedicated page, not a modal, because a planning conversation can run long and shouldn't be lost by navigating away or an API restart mid-conversation. You type: *"Add rate limiting to the public API so a single client can't exhaust our request budget."* A planner agent picks this up immediately — you watch it think live in the same conversation view — reading the existing API routes, and it may ask a clarifying question before proposing anything (e.g. "per-client rate limit — keyed by API key or by IP?"). Once it has enough, it proposes a breakdown: an epic card plus child cards (e.g. "Add token-bucket middleware," "Add per-client rate limit config," "Add 429 response + Retry-After header," "Add rate-limit metrics") — shown as a **proposal**, not yet on the board.

2. **Approve, then Ready.** Nothing exists on the board until you explicitly click **"Approve → create N cards"** — that's the real human checkpoint, not a formality; the epic + child cards + spec doc are only persisted at that moment. They land in `backlog`. From there you review, adjust priority/risk tier if needed, and drag a card to `ready`. This is the trigger — nothing runs until a card is in `ready`.

3. **In Progress.** The orchestrator picks it up (single-worker queue, so cards process one at a time by priority), spins up a fresh git worktree branched off `main`, and dispatches an **implementer** agent. Real example: for "Add 429 response + Retry-After header," the implementer reads the linked spec doc, writes the middleware change, adds a test hitting the rate limit and asserting a 429 with the header, runs the test suite in the worktree, and commits. You can click the pulsing dot on the card (or use the "watch" link that now appears directly on the board tile) to see this happen live — actual tool calls (`Read`, `Edit`, `Bash: pnpm test`), actual reasoning text, streaming in real time.

4. **In Review.** A **reviewer** agent — read-only, cannot edit or write files — checks the diff against the card's acceptance criteria one by one, and against any linked spec/ADR. It ends with a structured verdict: `VERDICT: PASS` or `VERDICT: FAIL`, plus a `CRITERION: ... -> SATISFIED/NOT SATISFIED` line per acceptance criterion. Any unsatisfied criterion or unparseable verdict fails closed — the card never slides through on ambiguity.

5. **Gate Checks.** If the reviewer passed, the card runs through the actual gate pipeline: `tests_ci` (full test suite in CI-equivalent conditions), `security_scan`, `docs_adr_linked` (architecture-touching cards must have a linked ADR), `adr_required`, `ci_status`, `peer_review` (mirrors the reviewer verdict), and `deploy_live` (an actual trial deploy with a health check). Real example: if "Add token-bucket middleware" touches shared middleware ordering, `docs_adr_linked` will fail the gate until someone links an ADR describing the architectural decision — the pipeline physically will not let an undocumented architecture change through.

6. **Awaiting Approval vs. auto-deploy.** This is risk-tier-driven:
   - **High risk / touches architecture** (e.g. changing how auth middleware or rate-limit state is shared across instances) → stops at `awaiting_approval`. A human must click through — **and this platform doesn't make you approve blind.** Clicking "Review & Approve" opens a real review: the actual diff, the reviewer agent's full replayed reasoning (not just a pass/fail badge), every gate result, and linked docs — all in one dialog, before you commit to "Approve → Deploy."
   - **Low/medium risk** (e.g. "Add rate-limit metrics," an additive, non-breaking change) → auto-advances straight to `deploying`. No human bottleneck for the boring, safe stuff.

7. **Deploying → Done.** The deploy engine merges the card's branch into `main` (`git merge --no-ff`), rebuilds/redeploys, and the card lands in `done`. Production example from this very platform's own history: a merge only proceeds if the target branch is clean and matches the expected base — if someone's mid-merge-conflict or the working tree is dirty, the deploy fails loudly with a specific reason instead of silently corrupting `main`.

8. **Blocked.** The escape hatch. A card lands here if: a gate fails, a reviewer fails it, an agent run crashes, or an agent raises a genuine `QUESTION:` that needs your judgment (see §6). A blocked card shows *why* right on the tile (e.g. "security_scan failed," or the open question text) — you don't have to dig through logs to find out. Click "Retry" to send it back to `ready` once the underlying issue (yours or the agent's) is resolved.

## 4. The Kanban board, day to day

- **Columns** map 1:1 to the lifecycle above: Backlog, Ready, In Progress, In Review, Gate Checks, Awaiting Approval, Deploying, Blocked, Done.
- **Drag and drop** works for manual transitions where the state machine allows it (e.g. dragging `blocked` back to `ready`).
- **Active-run visibility on the tile itself:** any card with a live agent shows a pulsing indicator, the role and status (e.g. "implementer running"), and — this is new — a live-updating one-line snippet of what it's actually doing right now (e.g. *"using Bash"* or a truncated excerpt of its current reasoning), plus a "watch" link that pops open the full live transcript without leaving the board. You no longer have to guess whether something died or is just slow.
- **Activity feed** (sidebar + `/activity` page) is the structured event log: card moves, gate pass/fail, doc drift detections. Good for "what happened when," not for "what is the agent thinking" — use the live watch view for that.
- **Dependency graph** (`/board/:id/graph`) visualizes `blocks`/`relates_to` relationships between cards — useful when an epic's child cards have real ordering constraints (e.g. "middleware" must land before "per-client config" can reference it).
- **Inbox** (`/inbox`) is everything on the current board actually waiting on you, filtered down from the noise: cards `awaiting_approval`, cards blocked on an open `QUESTION:` to you, and cards blocked for any other reason. The sidebar's Inbox badge count is this same real computation, not a raw activity-event count — if the badge says 2, `/inbox` shows exactly those 2 things.
- **Keyboard shortcuts** on the board: `j`/`k` move focus between cards, `a` opens the approval dialog for a focused `awaiting_approval` card, `?` shows the full list, `Escape` closes whatever's open.

## 5. Watching agents work (real-time visibility)

Every implementer/reviewer/planner run streams live: assistant reasoning text, every tool call (`Bash`, `Edit`, `Read`, ...) and its result, in a chat-style transcript. Two ways to reach it:

- **From the board:** click "watch" directly on an active card tile.
- **From a card's detail page:** Activity tab → Agent runs table → "View session." This table also nests **sub-agent delegation** — if an implementer spawns a sub-agent (via `spawn_sub_agent`) to handle a sub-task in parallel, you see it indented under its parent run with a "sub-agent" badge, not as an unexplained extra row.

A **completed** run opens read-only (transcript playback, no input box). A **live** run lets you type a message directly into the running agent — useful for production example: an implementer is 80% through a task but heading in a direction you don't like; you type "actually, use the existing `RateLimiter` class in `packages/shared` instead of writing a new one" directly into its live session instead of waiting for it to finish and fail review.

**Planning (`/plan`) is live too.** Submitting a new request doesn't show a bare spinner — you watch the planner agent's actual reasoning (and any clarifying questions it asks) stream in, the same chat-style view, ending in a proposal you explicitly approve before anything lands on the board.

## 6. Card Questions: when an agent needs a real human call

Agents don't guess on ambiguous product/business decisions. If an implementer or reviewer hits something genuinely outside its authority — e.g., *"the spec says 'rate limit per client' but doesn't say whether that's per API key or per IP — which one?"* — it ends its turn with a structured `QUESTION:` instead of failing or guessing. The card visibly pauses (not silently blocked-as-failure), the question shows up in the card's Activity tab with an answer box right there, and once you answer, the card auto-resumes with your answer injected into the next attempt's context — so the next run doesn't ask the same thing twice (up to the 5 most recent answered questions are carried forward).

## 7. Docs: the wiki agents actually read and write

Four doc types, all git-versioned under the hood:

- **wiki** — general specs, feature descriptions, org-chart role definitions. Example from this platform's own history: `org-chart-manager-agent-role` is a wiki doc specifying exactly what a tech-manager agent is allowed to do.
- **adr** (Architecture Decision Record) — required before an architecture-touching card can pass gates. Real example: before shipping shared rate-limit state across instances, you'd write an ADR explaining *why* (e.g. "chose in-memory-per-instance over centralized Redis counter to avoid a new hard dependency for a v1") — that ADR then gets linked to the card and the `docs_adr_linked`/`adr_required` gates pass.
- **rfc** — bigger, more discursive design proposals (e.g. the org-chart RFC describing Manager/Designer agent roles before they were built).
- **skill** — reusable, tag-matched or explicitly-linked knowledge an implementer should have on hand for a specific kind of task (e.g. a "how we write Drizzle migrations" skill doc that auto-attaches to any card tagged `db`).

Link a doc to a card via the card detail page's doc-links UI; agents automatically pull in tag-matched skill docs and any explicitly linked spec/ADR docs into their prompt context before they start working.

## 8. Approving deploys like you mean it

The "Review & Approve" dialog (not a bare button) is the single most important habit to build: for every high-risk card, actually read the diff, actually skim the reviewer's real reasoning (not just the pass/fail badge), and actually check which gates ran and what they found. Production discipline example: a card marked `touchesArchitecture: true` that changes how sessions are authenticated should get the same scrutiny you'd give a human's PR touching auth — the platform surfaces everything you need for that in one place; it doesn't replace your judgment, it removes your excuse for not exercising it.

## 9. Multi-agent org chart

Nine roles, all live: `implementer`, `reviewer`, `planner`, `triager`, `doc-scanner`, `tech-manager` (reviews epic decompositions, is the escalation target for `QUESTION:`s raised on that epic's child cards), `designer` (upstream UI/UX design spec before implementation on user-facing cards, downstream design-review pass afterward — same pattern as the code reviewer, but for UX consistency instead of correctness), `integrator` (resolves a rebase conflict inside a card's own worktree when its branch is synced onto the base before deploy, so trunk never sees an unresolved merge), and `analyzer` (runs once per project, at registration — see §1's "project brief").

## 10. Known rough edges (be aware, not alarmed)

- The API process runs natively (not containerized, by design — it needs live git/docker/claude-CLI access a container image doesn't have) while the web frontend runs in Docker. This means the API must be manually restarted after certain infra-level changes land — if the app behaves like it's ignoring recent changes, that's the first thing to check.
- Agents occasionally create their own scaffolding/verification cards (e.g. "e2e: add a muted Badge variant") as part of self-testing their own work — these are internal test artifacts, not real product cards, and are a known, tracked pattern rather than a bug.
- Agents currently have raw database access with no per-actor authentication distinct from a real human's actions — a known, tracked hardening gap, not yet fixed by design choice (prioritized behind feature work for now).
