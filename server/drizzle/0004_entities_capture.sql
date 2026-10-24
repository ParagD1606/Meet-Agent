CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "entities_aliases_idx" ON "entities" USING gin ("aliases");
--> statement-breakpoint
CREATE INDEX "entities_emb_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE TABLE "fact_entities" (
	"fact_id" bigint NOT NULL,
	"entity_id" text NOT NULL,
	CONSTRAINT "fact_entities_fact_id_entity_id_pk" PRIMARY KEY("fact_id","entity_id")
);
--> statement-breakpoint
CREATE INDEX "fact_entities_entity_idx" ON "fact_entities" USING btree ("entity_id");
--> statement-breakpoint
CREATE TABLE "entity_summaries" (
	"entity_id" text NOT NULL,
	"scope_tag" text NOT NULL,
	"summary" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_summaries_entity_id_scope_tag_pk" PRIMARY KEY("entity_id","scope_tag")
);
--> statement-breakpoint
ALTER TABLE "memory_edges" ADD COLUMN "relation" text;
--> statement-breakpoint
CREATE TABLE "capture_buffer" (
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"scope" jsonb NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permalink" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_buffer_channel_id_thread_ts_pk" PRIMARY KEY("channel_id","thread_ts")
);
