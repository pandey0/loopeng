# LoopEng — User-Facing Interaction Inventory

Design brief input: every point in the current UI where a human looks at something or acts on something. Organized by page/route, then by shared components used across pages. Each interactive element lists what it does and which API call it triggers, so a redesign can be judged against real behavior, not guesses.

Context: LoopEng is a kanban-style dev platform where AI agents (planner, implementer, reviewer, designer, tech-manager) do the actual implementation work on cards. The UI's job is mostly **visibility into autonomous work** (watch an agent think, in real time) plus a handful of **deliberate human checkpoints** (approve a risky deploy, answer a question an agent got stuck on, review a decomposition). It is not a traditional CRUD app — most "data entry" is the agents'; the human surface is small but high-stakes.

---

## 1. Global shell (present on every page)

### Left sidebar
- **Board** link → `/board`
- **Docs** link → `/docs`
- **Activity** link → `/activity`
- Active route highlighted

### Top bar
- **Board switcher** (dropdown) — selects the one "current board" for the whole app (persisted, drives every other page's scope)
- **"New" button** — disabled until a board is selected; opens the **Intake Modal** (see §5)
- **Notification bell**
  - Unread count badge (caps at "99+")
  - Click → dropdown of up to 50 recent events, newest first; each shows timestamp + description; card-related events link to `/card/{id}`
  - Opening the dropdown marks all as read

---

## 2. Board (`/board`) — the primary screen

**Purpose:** kanban view of every card, grouped into 9 columns matching the state machine:
`backlog → ready → in_progress → in_review → gate_checks → awaiting_approval → deploying → done`, plus `blocked` as an escape-hatch column.

**Per-card tile shows:** title, card type, priority, risk tier (color-coded), an "ADR" badge if it touches architecture, blocked-reason text (if blocked), and — if an agent is actively working it — a live indicator with role/status and a one-line streaming snippet of current activity.

### Interactions
- **Drag a card between columns** → `transitionCard(id, toState)`. Column highlights teal on a valid drop target, dims with a dashed border on an invalid one.
- **Click a card tile** → navigate to `/card/{id}` (full detail page)
- **"watch" link** on any actively-running card → opens a dialog with the live agent session (streaming transcript, see §6)
- **"Review & Approve" button** (only on cards in `awaiting_approval`) → opens the **Approval Dialog** (§2a)
- **"Retry" button** (only on cards in `blocked`) → transitions the card back to `ready`
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

## 5. Intake Modal (opened from "New" in the top bar)

**Purpose:** turn a freeform product-owner request into a decomposed epic + child cards, via the planner agent. Three phases in one dialog:

1. **Form**: textarea for the request text; Cancel / Submit buttons; errors shown inline with a Retry option
2. **Running**: "Planner agent is decomposing this request…" + the planner's live reasoning stream (same session panel as §6); polls intake status every 2s
3. **Result**: list of newly-created cards (title, type badge, risk badge); Close / "View on board" (navigates to `/board?highlight={ids}`, scrolls to and highlights the new cards)

---

## 6. Agent Session Panel (shared component, appears in 5 places)

Reused verbatim in: the board's "watch" dialog, the Approval Dialog's reviewer section, the card detail "View session" dialog, and the Intake Modal's running phase. This is the core "watch the AI work" experience and probably the most distinctive interaction surface in the product.

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
| Multi-step modal (form → live progress → result) | Intake |
| High-stakes review-then-approve dialog | Approval Dialog |
| Filter via button group | Docs list |
| Graph visualization | Dependency graph |

## Human decision points (the actual stakes, not just UI mechanics)

These are the moments the UI exists to serve — everything else is visibility scaffolding around them:

1. **Approve a deploy** (Approval Dialog) — the only point a human gates code going live, and only for high-risk/architecture-touching cards
2. **Answer a `QUESTION:`** (card detail, Activity tab) — an agent hit something it won't guess on
3. **Review a planner decomposition** (Intake Modal result, then dragging cards `backlog → ready`) — nothing runs until a human promotes a card
4. **Retry a blocked card** — after fixing whatever a human needed to fix
5. **Interject into a live agent session** — redirect an in-progress agent without waiting for it to finish and fail

## Current gaps worth flagging to a designer

- Dependency graph nodes aren't clickable — dead end in an otherwise-navigable app
- Doc version history is listed but not actionable (no diff/restore view)
- No visible surface for the state machine itself — a new user has no way to see the full `backlog → ... → done` shape except by reading columns left-to-right; the `blocked` escape-hatch column breaks that spatial logic
- Agent Session Panel is reused identically in 5 contexts but each host (modal size, surrounding chrome) is bespoke — a candidate for a single consistent "drawer" pattern
