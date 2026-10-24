ALTER TABLE "memories" ADD COLUMN "decayed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "consolidation_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"action" text NOT NULL,
	"scope_tag" text,
	"memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "consolidation_log_run_idx" ON "consolidation_log" USING btree ("run_id");
