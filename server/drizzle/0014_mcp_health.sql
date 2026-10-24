ALTER TABLE "mcp_connections" ADD COLUMN "allow_writes" boolean;
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "tool_meta" jsonb;
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "last_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "last_error" text;
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "connected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "reauth_notified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "mcp_connections" SET "connected_at" = "created_at" WHERE "status" = 'connected';
