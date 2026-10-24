ALTER TABLE "integration_pushes" ADD COLUMN IF NOT EXISTS "last_state" text;
--> statement-breakpoint
ALTER TABLE "integration_pushes" ADD COLUMN IF NOT EXISTS "synced_at" timestamp with time zone;
