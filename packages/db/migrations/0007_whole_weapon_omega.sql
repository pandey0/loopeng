ALTER TABLE "projects" ADD COLUMN "repo_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brief_doc_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brief_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_brief_doc_id_docs_id_fk" FOREIGN KEY ("brief_doc_id") REFERENCES "public"."docs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
