ALTER TABLE "agent_runs" ADD COLUMN "parent_agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
