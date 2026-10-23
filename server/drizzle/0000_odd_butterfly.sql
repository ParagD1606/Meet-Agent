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
	"proactivity" text DEFAULT 'default' NOT NULL,
	"observe" boolean DEFAULT false NOT NULL,
	"observed_up_to" text
);
--> statement-breakpoint
CREATE TABLE "chime_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_tag" text NOT NULL,
	"label" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"char_limit" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_cache" (
	"hash" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_tag" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"summary" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"permalink" text,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"valid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalid_at" timestamp with time zone,
	"learned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"permalink" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"review_state" text DEFAULT 'ok' NOT NULL,
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
CREATE TABLE "memory_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"memory_id" bigint,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"scope" text DEFAULT 'org' NOT NULL,
	"owner_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
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
	"selection" jsonb,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread_state" (
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"summary_upto_ts" text,
	"core_snapshot" jsonb,
	"turns_since_reflect" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_state_channel_id_thread_ts_pk" PRIMARY KEY("channel_id","thread_ts")
);
--> statement-breakpoint
CREATE TABLE "tool_results" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"cache_read_tokens" integer DEFAULT 0,
	"cache_write_tokens" integer DEFAULT 0,
	"prompt_breakdown" jsonb,
	"depth" text,
	"cost_micros" bigint DEFAULT 0,
	"model" text,
	"steps" integer DEFAULT 0,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
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
CREATE UNIQUE INDEX "core_blocks_scope_label" ON "core_blocks" USING btree ("scope_tag","label");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_thread_uniq" ON "episodes" USING btree ("channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "episodes_scope_idx" ON "episodes" USING btree ("scope_tag");--> statement-breakpoint
CREATE INDEX "episodes_emb_idx" ON "episodes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("scope_tag","status");--> statement-breakpoint
CREATE INDEX "memories_tsv_idx" ON "memories" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "memories_emb_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_reviews_status_idx" ON "memory_reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tool_results_turn_idx" ON "tool_results" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_feedback_uniq" ON "message_feedback" USING btree ("channel_id","message_ts","user_id");--> statement-breakpoint
CREATE INDEX "message_feedback_channel_idx" ON "message_feedback" USING btree ("channel_id");