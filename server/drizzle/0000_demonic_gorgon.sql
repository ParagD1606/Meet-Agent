CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"message_ts" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"cron" text,
	"run_at" timestamp with time zone,
	"dest_channel_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "channel_members_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_im" boolean DEFAULT false NOT NULL,
	"bot_is_member" boolean DEFAULT false NOT NULL,
	"proactivity" text DEFAULT 'default' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chime_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"rung" integer DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"auth_enc" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope_tag" text NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
	"source" text DEFAULT 'slack' NOT NULL,
	"source_ref" text,
	"kind" text DEFAULT 'fact' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"from_id" bigint NOT NULL,
	"to_id" bigint NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	CONSTRAINT "memory_edges_from_id_to_id_pk" PRIMARY KEY("from_id","to_id")
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"question" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"plan" jsonb,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sync_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"auth_enc" text,
	"cursor" text,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"user_id" text,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"title" text,
	"avatar_url" text,
	"role" text DEFAULT 'member' NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"deactivated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"bot_token_enc" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"home_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("scope_tag","status");--> statement-breakpoint
CREATE INDEX "memories_tsv_idx" ON "memories" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "memories_emb_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "message_feedback_uniq" ON "message_feedback" USING btree ("channel_id","message_ts","user_id");--> statement-breakpoint
CREATE INDEX "message_feedback_channel_idx" ON "message_feedback" USING btree ("channel_id");