-- Card 438646e5 follow-up: the sub-agent MCP server process no longer
-- book-keeps agent_runs via a direct Postgres connection (migrations
-- 0011/0012's loopeng_agent_runs role) -- it goes through the new,
-- authenticated POST /agent-runs and POST /agent-runs/:id/finish API routes
-- instead, same as every other agent-worktree-reachable mutation (see
-- @loopeng/agents' sub-agent.ts). That role's grants were table-wide across
-- every card's agent_runs rows, not scoped to the caller's own -- and its
-- fixed local-dev password sat in cleartext in .env.example, reachable by
-- any agent worktree via a plain file read even after DATABASE_URL itself
-- was denylisted from spawned agent processes (see AGENT_ENV_DENYLIST in
-- packages/agents/src/claude-cli.ts). Once nothing legitimate uses it, a
-- live, over-broad, publicly-known credential like this is a straight
-- liability -- revoke it outright rather than leave it dormant.
DO $$ BEGIN
	REVOKE ALL PRIVILEGES ON "agent_runs", "agent_roles", "docs" FROM "loopeng_agent_runs";
	REVOKE USAGE ON SCHEMA "public" FROM "loopeng_agent_runs";
EXCEPTION
	WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DROP ROLE IF EXISTS "loopeng_agent_runs";
