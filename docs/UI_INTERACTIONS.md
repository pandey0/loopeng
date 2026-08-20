# LoopEng — User-Facing Interaction Inventory

Design brief input: every point in the current UI where a human looks at something or acts on something. Organized by page/route, then by shared components used across pages. Each interactive element lists what it does and which API call it triggers, so a redesign can be judged against real behavior, not guesses.

Context: LoopEng is a kanban-style dev platform where AI agents (planner, implementer, reviewer, designer, tech-manager) do the actual implementation work on cards. The UI's job is mostly **visibility into autonomous work** (watch an agent think, in real time) plus a handful of **deliberate human checkpoints** (approve a risky deploy, answer a question an agent got stuck on, review a decomposition). It is not a traditional CRUD app — most "data entry" is the agents'; the human surface is small but high-stakes.

---

## 1. Global shell (present on every page)

### Left sidebar
- **Board** link → `/board`
- **Plan** link (💬) → `/plan`
- **Docs** link → `/docs`
- **Activity** link → `/activity`
- Active route highlighted

### Top bar
- **Board switcher** (dropdown) — selects the one "current board" for the whole app (persisted, drives every other page's scope)
- **"New" button** — disabled until a board is selected; navigates to `/plan` (see §5)
- **Notification bell**
  - Unread count badge (caps at "99+")
  - Click → dropdown of up to 50 recent events, newest first; each shows timestamp + description; card-related events link to `/card/{id}`
  - Opening the dropdown marks all as read

---

## 2. Board (`/board`) — the primary screen

**Purpose:** kanban view of every card, grouped into 10 columns matching the state machine:
`backlog → ready → in_progress → in_review → gate_checks → awaiting_approval → deploying → deploy_failed → blocked → done` (`apps/web/app/board/page.tsx`'s `PHASE_3_COLUMN_STATES`). `cancelled` cards get no column at all — cancelling is a terminal exit, not something the board surfaces once it happens.

**Stage pipeline bar** (`StagePipelineBar.tsx`, above the columns): a compact left-to-right count-per-stage strip for the happy path (`backlog → ... → done`), plus a visually separate "escape hatch" badge showing the combined `blocked + deploy_failed` count — the two "stuck, needs recovery" states are deliberately grouped apart from the main flow instead of breaking up its story.

**Title search** (top-right, next to the dependency-graph link): a text input that filters visible cards by title substring, client-side (`filterCardsByTitle`); focus it directly from anywhere on the board via a keyboard shortcut (§ below).

**Per-card tile shows:** title, card type, priority, risk tier (color-coded), an "ADR" badge if it touches architecture, blocked-reason text (if blocked), and — if an agent is actively working it — a live indicator with role/status and a one-line streaming snippet of current activity.

### Interactions
- **Drag a card between columns** → `transitionCard(id, toState)`. Column highlights teal on a valid drop target, dims with a dashed border on an invalid one.
- **Click a card tile** → navigate to `/card/{id}` (full detail page)
- **"watch" link** on any actively-running card → opens a dialog with the live agent session (streaming transcript, see §6)
- **"Review & Approve" button** (only on cards in `awaiting_approval`) → opens the **Approval Dialog** (§2a)
- **"Retry" button** (only on cards in `blocked`) → transitions the card back to `ready`
- **On a `deploy_failed` card**: the default next-step action retries just the deploy step (`deploy_failed → deploying`) rather than the full cycle — see `docs/ARCHITECTURE.md` §3 for why that's a deliberately separate lane from `blocked`.
- **"Dependency graph →"** link (top-right) → `/board/{boardId}/graph`
- **Activity feed sidebar** — live event stream (SSE), card-related entries link to `/card/{id}`
- Card list polls every 4s while any card has an active run; also invalidates on every incoming activity event

### 2a. Approval Dialog (the deploy gate)
This is the single highest-stakes human decision in the product — approving code an AI wrote to actually merge and deploy.
- Card summary: title, risk tier, priority, architecture flag
- **Reviewer verdict**: pass/fail, timestamp, and the reviewer agent's *full replayed reasoning* (not just a badge)
- **Gate results**: every gate (tests, security scan, ADR-linked, CI, peer review) with a status badge; failures auto-expand detail
- **Diff viewer**: collapsible, shows the real code diff (or a message if the worktree was already torn down)
- **Linked docs**: badges
- Buttons: **Cancel** (close) / **Approve → Deploy** (`transitionCard(id, "deploying")`)

---

## 3. Card detail (`/card/[cardId]`)

**Purpose:** everything about one card — spec, dependencies, full agent/gate history, open questions.

Two tabs:

### "Overview" tab
- Description, tags
- **Acceptance criteria**: list with per-item remove button; text input + "Add" to append; every change auto-saves
- **Dependencies**: cards this one depends on, clickable, shows dependency type (`blocks` / `relates_to`)
- **Dependents**: cards that depend on this one, same treatment, reverse direction
- **Linked docs**: clickable to `/docs/{slug}`, shows link type (`spec` / `adr` / `skill` / `related`)

### "Activity" tab
- **Questions**: agent-raised `QUESTION:` escalations. Each shows role, timestamp, question text; if open, a text input + "Answer" button (Enter also submits); once answered, becomes read-only with the answer and who answered
- **Timeline**: reverse-chronological feed of every event on this card (agent runs, gate results, state transitions) — display only
- **Agent runs table**: role, status, verdict, started/finished, "View session" button per row (opens the agent session dialog, §6). Sub-agent runs nest under their parent with a badge, instead of appearing as unexplained flat rows
- **Gate results table**: gate name, status badge, timestamp; expandable rows (auto-expand on failure) showing raw detail (stderr tail, failure reason, etc.)

---

## 4. Dependency graph (`/board/[boardId]/graph`)

**Purpose:** visual map of `blocks` / `relates_to` relationships between cards on the current board, via ReactFlow.
- Nodes = cards (title only); edges = dependency relationships, labeled by type; `blocks` edges are animated
- Standard graph controls: pan, zoom, fit-view
- Nodes are **not currently clickable** (display-only) — worth reconsidering in a redesign, since "click node to open card" is the obvious expectation
- Board switcher stays in sync when arriving here from a specific board

---

## 5. Plan (`/plan`) — conversational intake

**Purpose:** turn a freeform product-owner request into a decomposed epic + child cards, via the planner agent — as a dedicated page, not a modal, since a planning conversation can run long and nothing about it should be lost by navigating away or an api restart mid-conversation. Every session and its status is re-derived from the database on every load (`GET /boards/:id/intake[/...]`), not held in component state.

**Layout:** a 300px session list on the left, the active conversation on the right.

- **Left panel**: "New request" textarea + "Start conversation" button (`POST /boards/:id/intake`, returns `202` with an `agentRunId`, then routes to `/plan?session={id}`); below it, every past/current planning session on this board (`GET /boards/:id/intake`, polled every 4s), each showing a status badge (In conversation / Awaiting approval / Approved / Failed) and start time. Clicking one selects it.
- **Right panel**, once a session is selected (`GET /boards/:id/intake/:agentRunId`, polled every 2s while unsettled):
  - The planner's live/replayed session via the shared **Agent Session Panel** (§6) — the planner may ask clarifying questions before proposing anything.
  - **`awaiting_approval`**: a proposal card — spec title, the exact list of cards it would create (title, type badge, risk badge) — and an explicit **"Approve → create N cards"** button (`POST /boards/:id/intake/:agentRunId/approve`). Nothing is persisted to the board until this is clicked — this is the human checkpoint, not a formality.
  - **`succeeded`**: confirmation + card count. If the background manager review (kicked off right after approval) hasn't settled yet, shows "Manager is reviewing this breakdown…" instead of a board link, since the reviewed set can still replace the just-created card ids. Once settled, "View on board" navigates to `/board?highlight={ids}`.
  - **`failed`**: the error text.

---

## 6. Agent Session Panel (shared component, appears in 5 places)

Reused verbatim in: the board's "watch" dialog, the Approval Dialog's reviewer section, the card detail "View session" dialog, and the `/plan` page's conversation view. This is the core "watch the AI work" experience and probably the most distinctive interaction surface in the product.

- Chat-style transcript: assistant messages (left, muted), human messages (right, primary color), tool calls (collapsible — tool name + input), tool results (collapsible — output/error), status lines (centered, muted)
- Live indicator vs. "read-only playback" for completed runs
- **Input box** (only present when the session is live and the socket is open): text field + Send button, Enter also sends — lets a human interject a message *into a running agent's session* mid-task
- Auto-scrolls to newest message as events stream in
- Backed by a WebSocket to `/agent-runs/{id}/socket`; replays history first, then streams live

---

## 7. Docs list (`/docs`)

**Purpose:** browse the wiki (ADRs, RFCs, skills, general wiki pages).
- Filter buttons: All / wiki / adr / rfc / skill (single-select, immediate)
- Table: title (links to `/docs/{slug}`), type badge, status, tags
- **"+ New ADR"** link → `/docs/new/adr`

---

## 8. Doc detail (`/docs/[slug]`)

**Purpose:** read one document.
- Title, status badge, tags, rendered markdown body (headings/lists/code blocks/links)
- Sidebar: **linked cards** (which cards reference this doc) and **version history** (commit SHA, message, date) — history is currently display-only, not clickable to diff/restore

---

## 9. New ADR form (`/docs/new/adr`)

**Purpose:** create an Architecture Decision Record.
- Title (text, required, auto-focused)
- Summary (text, required) — "one line, shown in agent prompts instead of the full doc" — this field is load-bearing for the whole system's token-efficiency design, worth making its importance visible in the UI, not just a placeholder hint
- Tags (text, comma-separated, optional)
- Content (large textarea, pre-filled with an ADR template, fully editable)
- **"Create ADR"** button (shows "Creating…" while submitting) → creates the doc, redirects to `/docs/{slug}`

---

## 10. Activity (`/activity`)

**Purpose:** full-page version of the sidebar activity feed, scoped to the selected board.
- Reverse-chronological event list, card-related entries link to `/card/{id}`
- Otherwise display-only

---

## Interaction patterns, summarized

| Pattern | Where |
|---|---|
| Drag-and-drop state transition | Board columns |
| Click-to-navigate card/doc references | Everywhere (board, card detail, docs, activity) |
| Live WebSocket agent transcript, with mid-session chat input | Agent Session Panel (5 places) |
| Live SSE activity feed | Board sidebar, Activity page, notification bell |
| Polling fallback | Board card list (4s), intake status (2s) |
| Inline add/remove list editing | Acceptance criteria |
| Inline answer-a-question form | Card questions |
| Multi-turn conversation → explicit approval → result | Plan (`/plan`) |
| High-stakes review-then-approve dialog | Approval Dialog |
| Filter via button group | Docs list |
| Graph visualization | Dependency graph |

## Human decision points (the actual stakes, not just UI mechanics)

These are the moments the UI exists to serve — everything else is visibility scaffolding around them:

1. **Approve a deploy** (Approval Dialog) — the only point a human gates code going live, and only for high-risk/architecture-touching cards
2. **Answer a `QUESTION:`** (card detail, Activity tab) — an agent hit something it won't guess on
3. **Approve a planner decomposition** (`/plan`'s "Approve → create N cards", then dragging cards `backlog → ready`) — nothing exists on the board, let alone runs, until a human approves the plan and then promotes a card
4. **Retry a blocked card** — after fixing whatever a human needed to fix
5. **Interject into a live agent session** — redirect an in-progress agent without waiting for it to finish and fail

## Current gaps worth flagging to a designer

- Dependency graph nodes aren't clickable — dead end in an otherwise-navigable app
- Doc version history is listed but not actionable (no diff/restore view)
- No visible surface for the state machine itself — a new user has no way to see the full `backlog → ... → done` shape except by reading columns left-to-right; the `blocked` escape-hatch column breaks that spatial logic
- Agent Session Panel is reused identically in 5 contexts but each host (modal size, surrounding chrome) is bespoke — a candidate for a single consistent "drawer" pattern
