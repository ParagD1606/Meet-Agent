ALTER TABLE "commitments" ADD COLUMN "assigner_id" text;
--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "source_ts" text;
--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "source_hash" text;
--> statement-breakpoint
CREATE INDEX "commitments_source_ts_idx" ON "commitments" USING btree ("channel_id","source_ts");
--> statement-breakpoint
CREATE INDEX "commitments_thread_idx" ON "commitments" USING btree ("channel_id","thread_ts");
--> statement-breakpoint
ALTER TABLE "ambient_messages" ADD COLUMN "batch_ref" text;
--> statement-breakpoint
ALTER TABLE "ambient_messages" ADD COLUMN "text_hash" text;
--> statement-breakpoint
CREATE INDEX "ambient_batch_idx" ON "ambient_messages" USING btree ("channel_id","batch_ref");
--> statement-breakpoint
CREATE TABLE "follow_ups" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "target_id" text,
  "text" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "repeat_days" integer,
  "status" text DEFAULT 'pending' NOT NULL,
  "origin_channel_id" text,
  "origin_thread_ts" text,
  "send_count" integer DEFAULT 0 NOT NULL,
  "last_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" USING btree ("status","due_at");
--> statement-breakpoint
CREATE INDEX "follow_ups_owner_idx" ON "follow_ups" USING btree ("owner_id","status");
