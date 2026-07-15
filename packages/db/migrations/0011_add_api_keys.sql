CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- Least-privilege role for the sub-agent MCP server process (spawned inside
-- an agent's own worktree via --mcp-config -- see buildSubAgentMcpConfig in
-- @loopeng/agents). That process legitimately needs to persist agent_runs
-- bookkeeping (nested delegation rows + streamed transcript) but must never
-- get the full-access DATABASE_URL every other agent-worktree process just
-- lost (card 438646e5) -- this role can touch exactly agent_runs and
-- agent_roles (read-only) and nothing else in the shared database: no
-- cards, boards, docs, event_log, users, or api_keys. The password below is
-- a fixed local-dev default (matches the docker-compose postgres image,
-- which only ever runs locally) -- a real deployment rotates it with
-- ALTER ROLE ... PASSWORD outside of migrations and points
-- AGENT_RUNS_DATABASE_URL at the rotated credential.
DO $$ BEGIN
	CREATE ROLE "loopeng_agent_runs" WITH LOGIN PASSWORD 'loopeng_agent_runs_dev';
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "loopeng_agent_runs";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "agent_runs" TO "loopeng_agent_runs";
--> statement-breakpoint
GRANT SELECT ON "agent_roles" TO "loopeng_agent_runs";
