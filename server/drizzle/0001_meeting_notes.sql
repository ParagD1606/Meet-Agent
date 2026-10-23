CREATE TABLE "meetings" (
  "id" text PRIMARY KEY NOT NULL,
  "source_file_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_ts" text,
  "title" text NOT NULL,
  "transcript" text NOT NULL,
  "summary" text,
  "tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "participant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'processing' NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_source_file_uniq" ON "meetings" USING btree ("source_file_id");
--> statement-breakpoint
CREATE INDEX "meetings_channel_idx" ON "meetings" USING btree ("channel_id");
--> statement-breakpoint
CREATE INDEX "meetings_ended_idx" ON "meetings" USING btree ("ended_at");
