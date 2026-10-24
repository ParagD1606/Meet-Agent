ALTER TABLE "commitments" ADD COLUMN IF NOT EXISTS "external_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_pushes" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" text NOT NULL,
  "target" text NOT NULL,
  "task_ref" text NOT NULL,
  "external_id" text,
  "external_url" text,
  "status" text NOT NULL,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_pushes_task_idx" ON "integration_pushes" USING btree ("target","task_ref","status");
