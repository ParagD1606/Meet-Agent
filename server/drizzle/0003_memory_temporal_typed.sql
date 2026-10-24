CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "fact_type" text DEFAULT 'fact' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "context_prefix" text;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_scope" text;
--> statement-breakpoint
DROP INDEX "memories_tsv_idx";
--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "tsv";
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(context_prefix, '') || ' ' || text)) STORED;
--> statement-breakpoint
CREATE INDEX "memories_tsv_idx" ON "memories" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "memories_text_trgm_idx" ON "memories" USING gin ("text" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "memories_valid_until_idx" ON "memories" USING btree ("valid_until") WHERE "valid_until" IS NOT NULL;
