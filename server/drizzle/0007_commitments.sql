CREATE TABLE "commitments" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "text" text NOT NULL,
  "due_at" timestamp with time zone,
  "source_type" text NOT NULL,
  "source_ref" text NOT NULL,
  "permalink" text,
  "channel_id" text,
  "thread_ts" text,
  "scope_tag" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "last_nudged_at" timestamp with time zone,
  "nudge_count" integer DEFAULT 0 NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_source_uniq" ON "commitments" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX "commitments_owner_idx" ON "commitments" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "commitments_scope_idx" ON "commitments" USING btree ("scope_tag","status");--> statement-breakpoint
CREATE TABLE "manager_risks" (
  "key" text PRIMARY KEY NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
