import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { tsvector, vector } from "./_vector";

const ts = (name: string) => timestamp(name, { withTimezone: true }).defaultNow().notNull();

// ---------- identity ----------
export const workspace = pgTable("workspace", {
  id: text("id").primaryKey(), // Slack team id
  name: text("name"),
  botTokenEnc: text("bot_token_enc").notNull(), // AES-GCM, see crypto.ts
  botUserId: text("bot_user_id").notNull(),
  homeChannelId: text("home_channel_id"),
  createdAt: ts("created_at"),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(), // Slack user id
  name: text("name"),
  email: text("email"),
  title: text("title"),
  avatarUrl: text("avatar_url"),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  isBot: boolean("is_bot").notNull().default(false),
  deactivated: boolean("deactivated").notNull().default(false),
  createdAt: ts("created_at"),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name"),
  isPrivate: boolean("is_private").notNull().default(false),
  isIm: boolean("is_im").notNull().default(false),
  botIsMember: boolean("bot_is_member").notNull().default(false),
  proactivity: text("proactivity", { enum: ["default", "proactive", "quiet"] }).notNull().default("default"),
  /** Ambient learning: null/true = on (default for every channel the bot is in), false = admin opt-out (sticky). */
  observe: boolean("observe"),
  ambientNoticeAt: timestamp("ambient_notice_at", { withTimezone: true }), // the one-time "I learn from this channel" notice
  observedUpTo: text("observed_up_to"), // slack ts watermark of the passive-learning job
});

export const channelMembers = pgTable("channel_members", {
  channelId: text("channel_id").notNull(),
  userId: text("user_id").notNull(),
}, (t) => [primaryKey({ columns: [t.channelId, t.userId] })]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(), // e.g. workspace_prompt, proactivity_default, model_profile, embedding_model
  value: jsonb("value").notNull(),
});

export const events = pgTable("events", {
  id: text("id").primaryKey(), // Slack event_id / client_msg_id, dedupe
  createdAt: ts("created_at"),
}, (t) => [index("events_created_at_idx").on(t.createdAt)]);

// ---------- memory ----------
export const memories = pgTable("memories", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  scopeTag: text("scope_tag").notNull(), // shared | channel_{id} | user_{id}
  text: text("text").notNull(),
  embedding: vector("embedding").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', coalesce(context_prefix, '') || ' ' || text)`),
  source: text("source").notNull().default("slack"), // slack | upload | gdrive | onedrive | notion | research
  sourceRef: text("source_ref"),
  kind: text("kind", { enum: ["fact", "chunk"] }).notNull().default("fact"),
  // superseded = replaced by a newer fact; archived = consolidated away (restorable); deleted = forgotten on request. Rows are never hard-deleted.
  status: text("status", { enum: ["active", "superseded", "archived", "deleted"] }).notNull().default("active"),
  supersededBy: bigint("superseded_by", { mode: "number" }),
  validAt: ts("valid_at"), // when the fact became true (event time)
  invalidAt: timestamp("invalid_at", { withTimezone: true }), // set on supersede; history is kept
  validUntil: timestamp("valid_until", { withTimezone: true }), // forget-after horizon for transient facts; null = no expiry
  factType: text("fact_type", { enum: ["fact", "preference", "decision", "procedure", "opinion"] }).notNull().default("fact"),
  contextPrefix: text("context_prefix"), // LLM one-liner (who/channel/date/topic) prepended before embedding + tsvector; null = not generated yet, "" = none
  sourceScope: text("source_scope"), // scope tag the fact was first written in (survives promotion)
  learnedAt: ts("learned_at"), // when we ingested it
  createdBy: text("created_by"), // slack user id, or "bot"/"consolidation"/"sync"
  permalink: text("permalink"), // slack permalink / doc url
  confidence: real("confidence").notNull().default(1),
  importance: real("importance").notNull().default(0.5),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  decayedAt: timestamp("decayed_at", { withTimezone: true }), // importance decay is applied from max(decayed_at, last_accessed_at, valid_at)
  accessCount: integer("access_count").notNull().default(0),
  reviewState: text("review_state", { enum: ["ok", "pending", "rejected"] }).notNull().default("ok"),
  createdAt: ts("created_at"),
}, (t) => [
  index("memories_scope_idx").on(t.scopeTag, t.status),
  index("memories_tsv_idx").using("gin", t.tsv),
  index("memories_text_trgm_idx").using("gin", t.text.op("gin_trgm_ops")),
  index("memories_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

/** What recall returned for a turn, so feedback (message_feedback) and evals can be joined to the retrieved memory ids. */
export const recallLog = pgTable("recall_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  channelId: text("channel_id").notNull(),
  threadKey: text("thread_key").notNull(),
  /** Slack ts of the user message that triggered the turn. */
  messageTs: text("message_ts").notNull(),
  query: text("query").notNull(),
  hitIds: jsonb("hit_ids").$type<number[]>().notNull().default([]),
  createdAt: ts("created_at"),
}, (t) => [
  index("recall_log_thread_idx").on(t.channelId, t.threadKey),
  index("recall_log_created_idx").on(t.createdAt),
]);

export const memoryEdges = pgTable("memory_edges", {
  fromId: bigint("from_id", { mode: "number" }).notNull(),
  toId: bigint("to_id", { mode: "number" }).notNull(),
  weight: real("weight").notNull().default(1),
  relation: text("relation"), // null = plain cosine link; otherwise a typed edge (supersedes, owns, part_of, ...)
}, (t) => [primaryKey({ columns: [t.fromId, t.toId] })]);

// ---------- tools ----------
export const mcpConnections = pgTable("mcp_connections", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // preset key or "custom"
  label: text("label").notNull(),
  url: text("url").notNull(),
  scope: text("scope", { enum: ["org", "user"] }).notNull(),
  ownerUserId: text("owner_user_id"), // null for org
  authEnc: text("auth_enc"), // encrypted JSON {accessToken, refreshToken, expiresAt, clientInfo}
  status: text("status", { enum: ["pending", "connected", "error", "needs_reauth"] }).notNull().default("pending"),
  createdAt: ts("created_at"),
  /** Per-connection override of the workspace `mcp_org_writes` setting (org connections only); null = inherit. */
  allowWrites: boolean("allow_writes"),
  /** Cached tool catalogue from the last successful verification: [{name, kind, cls}] (no schemas, no secrets). */
  toolMeta: jsonb("tool_meta").$type<{ name: string; kind: "read" | "write"; cls: string }[]>(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  lastError: text("last_error"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  /** One-time "needs reconnect" notice already sent; reset when the connection recovers. */
  reauthNotified: boolean("reauth_notified").notNull().default(false),
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  turnId: text("turn_id").notNull(),
  requesterId: text("requester_id").notNull(),
  toolName: text("tool_name").notNull(),
  args: jsonb("args").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  messageTs: text("message_ts"),
  status: text("status", { enum: ["pending", "approved", "denied", "expired"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: ts("created_at"),
});

export const leases = pgTable("leases", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  requesterId: text("requester_id").notNull(),
  turnId: text("turn_id").notNull(),
  status: text("status", { enum: ["pending", "granted", "denied", "expired", "used"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ---------- behavior ----------
export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  scope: text("scope", { enum: ["org", "user"] }).notNull().default("org"),
  ownerUserId: text("owner_user_id"), // set when scope = "user"
  version: integer("version").notNull().default(1), // optimistic lock
  createdBy: text("created_by"),
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("skills_name_owner_idx").on(sql`lower(${t.name})`, sql`coalesce(${t.ownerUserId}, '')`)]);

export const automations = pgTable("automations", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  kind: text("kind", { enum: ["digest", "reminder"] }).notNull(),
  prompt: text("prompt").notNull(),
  cron: text("cron"), // null => one-off at runAt
  runAt: timestamp("run_at", { withTimezone: true }),
  destChannelId: text("dest_channel_id"), // null => DM owner
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  createdAt: ts("created_at"),
});

/** A completed Slack Huddle whose saved transcript was made available to the app. */
export const meetings = pgTable("meetings", {
  id: text("id").primaryKey(),
  /** Slack file id. One meeting record per saved Huddle transcript. */
  sourceFileId: text("source_file_id").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  /** Where the transcript came from: "slack" or a browser-extension platform (meet, teams, zoom, ...). */
  platform: text("platform").notNull().default("slack"),
  /** Set for extension uploads, which have no Slack channel; only the owner (and admins) can read them. */
  ownerId: text("owner_id"),
  title: text("title").notNull(),
  transcript: text("transcript").notNull(),
  summary: text("summary"),
  /** Extracted action items; Jira references are added later when approved/created. */
  tasks: jsonb("tasks").notNull().default([]),
  /** Decisions made in the meeting (strings). */
  decisions: jsonb("decisions").notNull().default([]),
  participantIds: jsonb("participant_ids").notNull().default([]),
  status: text("status", { enum: ["processing", "ready", "failed"] }).notNull().default("processing"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
}, (t) => [
  uniqueIndex("meetings_source_file_uniq").on(t.sourceFileId),
  index("meetings_channel_idx").on(t.channelId),
  index("meetings_ended_idx").on(t.endedAt),
]);

/** Delivery history for task-assignment DMs. A task may be reassigned after a recipient declines it. */
export const meetingTaskNotifications = pgTable("meeting_task_notifications", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id").notNull(),
  taskId: text("task_id").notNull(),
  recipientUserId: text("recipient_user_id").notNull(),
  status: text("status", { enum: ["sent", "acknowledged", "declined", "failed"] }).notNull(),
  dmChannelId: text("dm_channel_id"),
  messageTs: text("message_ts"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
}, (t) => [
  uniqueIndex("meeting_task_notification_recipient_uniq").on(t.meetingId, t.taskId, t.recipientUserId),
  index("meeting_task_notification_meeting_idx").on(t.meetingId),
]);

export const researchRuns = pgTable("research_runs", {
  id: text("id").primaryKey(),
  requesterId: text("requester_id").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  question: text("question").notNull(),
  status: text("status", { enum: ["planned", "running", "done", "failed"] }).notNull().default("planned"),
  plan: jsonb("plan"),
  result: text("result"),
  createdAt: ts("created_at"),
});

export const journeyState = pgTable("journey_state", {
  userId: text("user_id").primaryKey(),
  rung: integer("rung").notNull().default(0),
  data: jsonb("data").notNull().default({}),
  updatedAt: ts("updated_at"),
});

export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  hash: text("hash").notNull(), // sha256 of token
  /** "mcp" tokens (admin-made) open the outward MCP server; "ext" tokens, which anyone can make for themselves, only serve the browser extension. */
  kind: text("kind", { enum: ["mcp", "ext"] }).notNull().default("mcp"),
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("api_tokens_hash_idx").on(t.hash)]);

export const syncSources = pgTable("sync_sources", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["gdrive", "onedrive", "notion"] }).notNull(),
  authEnc: text("auth_enc"),
  cursor: text("cursor"),
  selection: jsonb("selection"), // admin-chosen folders/workspaces; null = nothing selected = nothing synced
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
});

// ---------- observability ----------
export const turns = pgTable("turns", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  userId: text("user_id"),
  trigger: text("trigger").notNull(), // mention | dm | chime | automation | research
  status: text("status", { enum: ["running", "done", "error", "waiting_approval"] }).notNull().default("running"),
  toolCalls: jsonb("tool_calls").notNull().default([]),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cacheReadTokens: integer("cache_read_tokens").default(0),
  cacheWriteTokens: integer("cache_write_tokens").default(0),
  promptBreakdown: jsonb("prompt_breakdown"), // {system,coreBlocks,skills,toolSchemas,history,recall,toolResults,user} approx tokens, first step
  depth: text("depth"), // router decision: direct | memory | tools | deep
  costMicros: bigint("cost_micros", { mode: "number" }).default(0), // USD * 1e6, estimated
  model: text("model"),
  steps: integer("steps").default(0),
  error: text("error"),
  startedAt: ts("started_at"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("turns_thread_idx").on(t.channelId, t.threadTs)]);

export const chimeLog = pgTable("chime_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts"),
  at: ts("at"),
});

// Per-area extra tables (owned by each module author). Keep barrel lines here.
export * from "./extra-memory";
export * from "./extra-slack";
export * from "./extra-turn";
export * from "./extra-platform";
export * from "./extra-api";
export * from "./manager";

// ---------- memory tiers (agent B) ----------
export const coreBlocks = pgTable("core_blocks", {
  id: text("id").primaryKey(),
  scopeTag: text("scope_tag").notNull(), // shared | channel_{id} | user_{id}
  label: text("label", { enum: ["company", "channel", "user"] }).notNull(),
  text: text("text").notNull().default(""),
  charLimit: integer("char_limit").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at"),
}, (t) => [uniqueIndex("core_blocks_scope_label").on(t.scopeTag, t.label)]);

export const episodes = pgTable("episodes", {
  id: text("id").primaryKey(),
  scopeTag: text("scope_tag").notNull(),
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  summary: text("summary").notNull(),
  embedding: vector("embedding").notNull(),
  permalink: text("permalink"),
  endedAt: ts("ended_at"),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("episodes_thread_uniq").on(t.channelId, t.threadTs),
  index("episodes_scope_idx").on(t.scopeTag),
  index("episodes_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

export const threadState = pgTable("thread_state", {
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  summary: text("summary").notNull().default(""), // rolling structured summary (compaction)
  summaryUptoTs: text("summary_upto_ts"),
  coreSnapshot: jsonb("core_snapshot"), // frozen core blocks for prompt-cache stability
  turnsSinceReflect: integer("turns_since_reflect").notNull().default(0),
  /** "New chat": history, summaries and the frozen snapshot older than this are ignored. Key (channel, thread_ts) or (channel, 'dm'). */
  contextResetAt: timestamp("context_reset_at", { withTimezone: true }),
  updatedAt: ts("updated_at"),
}, (t) => [primaryKey({ columns: [t.channelId, t.threadTs] })]);

export const memoryReviews = pgTable("memory_reviews", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["supersede", "low_confidence", "core_block", "shared_write", "procedure", "doc_conflict"] }).notNull(),
  memoryId: bigint("memory_id", { mode: "number" }),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  requestedBy: text("requested_by"),
  decidedBy: text("decided_by"),
  createdAt: ts("created_at"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [index("memory_reviews_status_idx").on(t.status)]);

export const toolResults = pgTable("tool_results", {
  id: text("id").primaryKey(), // handle the model can pass to read_tool_result
  turnId: text("turn_id").notNull(),
  toolName: text("tool_name").notNull(),
  content: text("content").notNull(),
  bytes: integer("bytes").notNull(),
  createdAt: ts("created_at"),
}, (t) => [index("tool_results_turn_idx").on(t.turnId)]);

// ---------- cost controls (agent A) ----------
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(), // e.g. user:U1, channel:C1:triage
  tokens: real("tokens").notNull(),
  updatedAt: ts("updated_at"),
});

export const usageDaily = pgTable("usage_daily", {
  userId: text("user_id").notNull(),
  day: text("day").notNull(), // YYYY-MM-DD UTC
  turns: integer("turns").notNull().default(0),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] })]);

// ---------- embedding cost control ----------
export const embeddingCache = pgTable("embedding_cache", {
  hash: text("hash").primaryKey(), // sha256(model + "\n" + text)
  embedding: vector("embedding").notNull(),
  createdAt: ts("created_at"),
});

// ---------- entity layer ----------
/** People, channels, customers, projects. `aliases` holds normalised surface forms (canonical name included) for exact lookup. */
export const entities = pgTable("entities", {
  id: text("id").primaryKey(),
  canonicalName: text("canonical_name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  type: text("type").notNull().default("other"), // person | channel | org | project | product | other
  embedding: vector("embedding").notNull(),
  createdAt: ts("created_at"),
}, (t) => [
  index("entities_aliases_idx").using("gin", t.aliases),
  index("entities_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

export const factEntities = pgTable("fact_entities", {
  factId: bigint("fact_id", { mode: "number" }).notNull(),
  entityId: text("entity_id").notNull(),
}, (t) => [primaryKey({ columns: [t.factId, t.entityId] }), index("fact_entities_entity_idx").on(t.entityId)]);

/** One summary per (entity, scope): built only from facts readable in that scope, so a summary never widens visibility. */
export const entitySummaries = pgTable("entity_summaries", {
  entityId: text("entity_id").notNull(),
  scopeTag: text("scope_tag").notNull(),
  summary: text("summary").notNull(),
  updatedAt: ts("updated_at"),
}, (t) => [primaryKey({ columns: [t.entityId, t.scopeTag] })]);

// ---------- capture robustness ----------
/** Debounce buffer of thread transcripts waiting for extraction; survives restarts (flushed on boot and by the idle sweep). */
export const captureBuffer = pgTable("capture_buffer", {
  channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(),
  scope: jsonb("scope").notNull(),
  chunks: jsonb("chunks").$type<string[]>().notNull().default([]),
  permalink: text("permalink"),
  attempts: integer("attempts").notNull().default(0),
  lastAt: ts("last_at"),
}, (t) => [primaryKey({ columns: [t.channelId, t.threadTs] }), index("capture_buffer_last_at_idx").on(t.lastAt)]);

/** Ambient channel messages: buffer (text kept until flushed, then blanked) and the (channel, ts) idempotency ledger shared by events and the poll. */
export const ambientMessages = pgTable("ambient_messages", {
  channelId: text("channel_id").notNull(),
  ts: text("ts").notNull(),
  threadTs: text("thread_ts"),
  userId: text("user_id"),
  text: text("text").notNull().default(""),
  flushedAt: timestamp("flushed_at", { withTimezone: true }),
  createdAt: ts("created_at"),
  batchRef: text("batch_ref"), // memories.source_ref of the extraction batch this message went into (edit/delete sync)
  textHash: text("text_hash"), // hash of the raw message text (a message_changed with the same text is a no-op)
}, (t) => [primaryKey({ columns: [t.channelId, t.ts] }), index("ambient_pending_idx").on(t.channelId, t.flushedAt), index("ambient_batch_idx").on(t.channelId, t.batchRef)]);

// ---------- consolidation audit ----------
export const consolidationLog = pgTable("consolidation_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: text("run_id").notNull(),
  action: text("action").notNull(), // merge | cross_scope | decay | summarise | expire | promote | demote | about_block | procedure
  scopeTag: text("scope_tag"),
  memoryIds: jsonb("memory_ids").$type<number[]>().notNull().default([]),
  /** Snapshot needed to undo: { rows: [{id,status,supersededBy,invalidAt,importance,decayedAt}], created: number[], block?: {...} } */
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
}, (t) => [index("consolidation_log_run_idx").on(t.runId)]);
