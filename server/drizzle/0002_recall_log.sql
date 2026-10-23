CREATE TABLE "recall_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL,
  "thread_key" text NOT NULL,
  "message_ts" text NOT NULL,
  "query" text NOT NULL,
  "hit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recall_log_thread_idx" ON "recall_log" USING btree ("channel_id","thread_key");
--> statement-breakpoint
CREATE INDEX "recall_log_created_idx" ON "recall_log" USING btree ("created_at");
