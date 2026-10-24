CREATE INDEX IF NOT EXISTS "capture_buffer_last_at_idx" ON "capture_buffer" USING btree ("last_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_at_idx" ON "events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_reminders_reminded_at_idx" ON "memory_reminders" USING btree ("reminded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manager_risks_posted_at_idx" ON "manager_risks" USING btree ("posted_at");
