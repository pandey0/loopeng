# The loopeng User Journey: What You Do, What Happens Underneath

One continuous walkthrough, step by step: what you (the product owner) actually click/type, and exactly what fires in the codebase behind it. Paired with `USER_GUIDE.md` (day-to-day usage) and `ARCHITECTURE.md` (component reference) — this doc is the narrative that ties both together through a single real scenario.

**Scenario**: a real incident — guest users hitting a 500 on checkout because a null email crashes the receipt-sender. You'll use this one scenario end to end.

---

## Step 1 — You type the request

**You do**: open the board, click "New request," type: *"Checkout crashes with a 500 for guest users — looks like the receipt email step assumes a logged-in user's email is always set. Fix it and add a test so it can't regress."*

**Under the hood**:
- `POST /boards/:id/intake` (`apps/api/src/routes/intake.ts`) validates the input against `IntakeInputSchema`, confirms the board exists, then calls `startPlannerAgent(boardId, requestText)`.
- That function inserts an `agent_runs` row (role `planner`, status `queued`) **first**, then returns `{ agentRunId, result }` — the HTTP response goes back to your browser as `202 { agentRunId }` immediately, without waiting for the agent to finish. Everything from here runs as a detached background task; a `Promise` chain (`result.then(...).catch(...)`) records the terminal outcome into a process-local `intakeOutcomes` map when it's done.
- A real `claude` CLI subprocess spawns with the planner's system prompt, given read access to the repo. Its transcript streams into `agent_runs.transcript` (jsonb) incrementally via `makeTranscriptAppender` as it works.

## Step 2 — You watch it think instead of staring at a spinner

**You do**: the intake modal stays open, now rendering an `AgentSessionPanel` instead of a loading spinner, polling `GET /boards/:id/intake/:agentRunId` every 2 seconds.

**Under the hood**:
- The frontend also opens a WebSocket to `GET /agent-runs/:id/socket`. That route looks the run up in the API process's in-memory `sessionRegistry` (`Map<agentRunId, StreamingSession>`); since the run is live, it replays everything captured so far then streams new events as they arrive.
- You see the planner actually read `apps/web/app/checkout/*`, find the email-send call, reason about the null case, and decide on a decomposition. This takes roughly 30–90 seconds for a request this size.

## Step 3 — The decomposition lands, a manager reviews it, then you triage

**You do**: nothing yet — you just watch the epic and its child cards appear in the `backlog` column.

**Under the hood**:
- The planner's real output is parsed (`PlannerOutputError` thrown and surfaced as a `failed` outcome if it can't be parsed cleanly — fails closed rather than guessing), then persisted: one epic card ("Fix checkout 500 for guest users"), child cards like "Guard null email before receipt send," "Add regression test: guest checkout completes without email," each linked to a freshly-written spec doc (`docs` table, doc-engine commits it to the git-backed wiki repo).
- An `event_log` row (`card.intake_decomposed`) fires.
- Immediately after, still in the same background chain, `runManagerAgent(epicCardId)` runs — a read-only tech-manager review of the fresh breakdown (no worktree of its own; it just reads the main checkout). It might merge two overly-granular child cards or flag one as higher risk than the planner guessed. Another `event_log` row (`card.epic_reviewed`) fires, and *this* manager-adjusted card list is what the intake outcome finally reports as `succeeded` — not the planner's raw first draft.
- You now poll `GET /boards/:id/intake/:agentRunId`, see `status: "succeeded"`, and the modal closes. The cards are sitting in `backlog`.

## Step 4 — You promote the card that matters right now

**You do**: drag "Guard null email before receipt send" from `backlog` to `ready`. Leave the regression-test card in `backlog` for now since it depends on the fix landing first.

**Under the hood**:
- `POST /cards/:id/transition` validates the move against `TRANSITIONS` in `packages/shared/src/state-machine.ts` (`backlog -> ready` is a legal edge) and calls `applyTransition`, which writes the new `state` and an `event_log` row.
- That state change is exactly what the orchestrator's **event trigger** is watching for (`packages/orchestrator/src/triggers/event-trigger.ts`) — within moments, not on the next cron sweep, it picks the card up.

## Step 5 — The implementer actually writes the fix

**You do**: nothing — but you notice the card tile on the board now shows a pulsing dot, "implementer running," and a live one-line snippet ("using Edit" or a truncated reasoning excerpt) updating every few seconds.

**Under the hood**:
- `orchestrateCard()` (`packages/orchestrator/src/loop.ts`) transitions the card to `in_progress`, creates a fresh git worktree branched off `main` (`createWorktree`, via `@loopeng/worktree-manager` — a real isolated checkout on disk, its own branch), and calls `runImplementerAgent`.
- A real `claude` CLI process spawns in that worktree with the implementer role prompt, the card's description, acceptance criteria, and the linked spec doc's slug (it fetches the full doc on demand via the `get_doc` MCP tool rather than the whole thing being inlined into the prompt). It reads the checkout flow, finds the `sendReceiptEmail(user.email)` call, adds a null-guard, commits.
- Every stream event lands in `agent_runs.transcript` in real time; `getSessionSnippet` scans it backwards for the most recent renderable text/tool-use to produce the board's one-line snippet, capped at 120 chars.
- If it needs your judgment mid-run — say it discovers the email field is nullable for a second, unrelated reason and isn't sure whether that's in scope — it can raise a `QUESTION:`. That inserts a `card_questions` row, routes it (to you directly, or to the tech-manager if this epic went through manager review), fires a `card.question_raised` event, and transitions the card to `blocked` **without** consuming one of its retry attempts. You'd answer it via the card detail page, which flips the question to `answered` and sends the card back to `ready` for redispatch.
- Assuming no question: implementer finishes cleanly, `implResult.isError` is false, card moves to `in_review`.

## Step 6 — An independent reviewer checks the actual diff

**You do**: still nothing — but if you're curious, you click "watch" on the tile and see a second agent's session, this one read-only.

**Under the hood**:
- `runReviewerAgent(currentCard)` spawns a fresh `claude` process — no edit/write tools — that pulls the real diff and checks it line by line against every acceptance criterion on the card ("guest checkout completes without a 500," "existing logged-in flow unaffected," etc.). It ends its transcript with a structured `VERDICT: PASS` or `VERDICT: FAIL` plus one `CRITERION: ... -> SATISFIED/NOT SATISFIED` line per criterion.
- That verdict is recorded as the `peer_review` gate result (`recordPeerReviewGate` inserts a `gate_results` row). If it fails and attempts remain, the card bounces back to `in_progress` with the rejection text fed into the next attempt's prompt as `priorFailureNote` — the implementer gets to see exactly what it did wrong. After 3 total attempts, it blocks for real.
- Here: `VERDICT: PASS`. Card moves to `gate_checks`.

## Step 7 — The automated gate pipeline runs for real

**You do**: nothing — but the card detail page's gate list fills in row by row as each one finishes.

**Under the hood**:
- `runGatePipeline` (`packages/gates/src/pipeline.ts`) iterates every enabled `gate_definitions` row and actually runs each: `tests_ci` runs the real test suite in the worktree, `security_scan` scans the diff, `docs_adr_linked` checks whether this card touches shared architecture and, if so, whether an ADR is linked (this fix doesn't touch architecture, so it's skipped — `appliesTo()` returned false), `ci_status` mirrors CI, `design_review` only applies to UI-tagged cards (skipped here).
- Every single one — passed, failed, or skipped — gets a real `gate_results` row with a `detail` payload, immediately, not just a final summary. On the card page, any failure-like result auto-expands its detail in a collapsible section, red-bordered, so you don't have to dig through logs to see *why* something failed.
- All blocking gates pass. Since this card's `riskTier` is `medium` (it's a null-check + test, not an architecture change), it auto-advances straight to `deploying` — no human bottleneck for the safe stuff.

## Step 8 — (The path not taken here) High-risk cards stop for you

**You do**: *if* this had been tagged `high` risk — say it touched shared auth/session middleware instead — the card would sit at `awaiting_approval` and you'd click "Review & Approve."

**Under the hood, if it had**: that dialog fetches `GET /cards/:id/diff` (the real repo diff from the worktree's base commit) and the latest reviewer run's full transcript via a read-only `AgentSessionPanel`, alongside every gate result and linked docs — all in one view, before "Approve → Deploy" is even clickable. Approving triggers `applyTransition({ toState: "deploying" })`, same downstream path as the auto-advance case below.

## Step 9 — Deploy, for real

**You do**: nothing — watch the card slide into `deploying` then `done`.

**Under the hood**:
- `runDeployPipeline` (`packages/deploy-engine/src/pipeline.ts`) inserts a `deploy_records` row, then the docker-compose provider checks the target repo is on the expected base branch and clean — if someone left uncommitted changes on `main` or it's mid-merge-conflict, this refuses loudly with a specific `detail.reason` instead of silently corrupting `main`. Clean here, so it merges the worktree branch with `git merge --no-ff`, rebuilds/redeploys the `web` container (`docker compose ... --build web`), health-checks it.
- Healthy: `deploy_records.status = "live"`, a `deploy_live` gate result is recorded `passed`, the card transitions to `done`, and the worktree is torn down (`merged`).
- Guest checkout no longer 500s. The regression-test card, still in `backlog`, is now unblocked for you to promote next — its dependency on this one is tracked via a `card_dependencies` row so the board's dependency graph shows the real ordering.

## Step 10 — If something *had* gone wrong

**You do**: see the card land in `blocked` with a specific reason already written on the tile — never a blank "blocked" with no explanation.

**Under the hood**: `computeBlockedReasons` (`packages/board-engine/src/card-status.ts`) checks, per card, whichever of these happened most recently and uses that: a failing gate ("security_scan failed"), a failed/rejected agent run ("implementer failed" / "reviewer rejected"), an open question ("waiting on answer: ..."), or — a case that used to fall through silently — a run still stuck `running`/`verifying` (an API-restart orphan: "implementer run interrupted (stuck in \"running\" — likely an API restart mid-run)"). If truly nothing matches any of those, it says so explicitly ("blocked with no recorded cause — check agent run and gate history") rather than showing nothing. You drag it back to `ready` once you've resolved whatever it was (or, for a genuine code-level failure, the retry mechanism already tried 3 times before giving up).

---

## The whole loop, compressed

```
you type a request
  -> planner (live-streamed) drafts spec + decomposition -> backlog
  -> manager reviews the epic's breakdown -> backlog (adjusted)
you promote a card -> ready
  -> event trigger dispatches -> worktree created -> implementer writes code (live-streamed)
  -> reviewer checks the diff independently (live-streamed) -> peer_review gate
  -> gate pipeline runs every check for real -> gate_results rows
  -> risk-tier routes: high -> you approve with full context | low/medium -> auto
  -> deploy pipeline merges + redeploys + health-checks -> done
  -> anything failing at any stage -> blocked, with a real reason on the tile
```

Every arrow above is a real subprocess, a real git operation, or a real HTTP/deploy action — nothing in this loop is simulated once a card reaches `ready`.
