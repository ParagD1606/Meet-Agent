ALTER TABLE "commitments" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "memory_id" integer;
--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "title_key" text;
--> statement-breakpoint
UPDATE "commitments" SET "title_key" = trim(regexp_replace(lower("text"), '[^a-z0-9]+', ' ', 'g'));
--> statement-breakpoint
CREATE INDEX "commitments_dedupe_idx" ON "commitments" USING btree ("owner_id","title_key","channel_id");
