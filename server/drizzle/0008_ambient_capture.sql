ALTER TABLE "channels" ALTER COLUMN "observe" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "observe" DROP DEFAULT;
--> statement-breakpoint
UPDATE "channels" SET "observe" = NULL WHERE "observe" = false;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ambient_notice_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "ambient_messages" (
  "channel_id" text NOT NULL,
  "ts" text NOT NULL,
  "thread_ts" text,
  "user_id" text,
  "text" text DEFAULT '' NOT NULL,
  "flushed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ambient_messages_channel_id_ts_pk" PRIMARY KEY("channel_id","ts")
);
--> statement-breakpoint
CREATE INDEX "ambient_pending_idx" ON "ambient_messages" USING btree ("channel_id","flushed_at");
