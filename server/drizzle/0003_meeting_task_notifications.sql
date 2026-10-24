CREATE TABLE "meeting_task_notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "meeting_id" text NOT NULL,
  "task_id" text NOT NULL,
  "recipient_user_id" text NOT NULL,
  "status" text NOT NULL,
  "dm_channel_id" text,
  "message_ts" text,
  "error" text,
  "sent_at" timestamp with time zone,
  "acknowledged_at" timestamp with time zone,
  "declined_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_task_notification_recipient_uniq" ON "meeting_task_notifications" USING btree ("meeting_id","task_id","recipient_user_id");
--> statement-breakpoint
CREATE INDEX "meeting_task_notification_meeting_idx" ON "meeting_task_notifications" USING btree ("meeting_id");
