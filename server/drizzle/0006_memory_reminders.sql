CREATE TABLE "memory_reminders" (
  "memory_id" bigint PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL,
  "reminded_at" timestamp with time zone DEFAULT now() NOT NULL
);
