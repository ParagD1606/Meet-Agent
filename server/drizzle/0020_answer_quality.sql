ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "ranks" jsonb;
--> statement-breakpoint
ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "scores" jsonb;
--> statement-breakpoint
ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "rewritten_query" text;
--> statement-breakpoint
ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "abstain_signal" text;
--> statement-breakpoint
ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "pack_tokens" integer;
--> statement-breakpoint
ALTER TABLE "recall_log" ADD COLUMN IF NOT EXISTS "depth" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "answer_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"signal" text,
	"abstained" boolean DEFAULT false NOT NULL,
	"stripped_links" integer DEFAULT 0 NOT NULL,
	"tautology_blocked" boolean DEFAULT false NOT NULL,
	"receipt_mismatch" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_checks_turn_idx" ON "answer_checks" USING btree ("turn_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_checks_at_idx" ON "answer_checks" USING btree ("at");
