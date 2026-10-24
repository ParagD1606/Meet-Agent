ALTER TABLE "meetings" ADD COLUMN "platform" text DEFAULT 'slack' NOT NULL;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "owner_id" text;
