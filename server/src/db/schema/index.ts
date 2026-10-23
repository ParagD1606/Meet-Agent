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
});

// ---------- memory ----------
export const memories = pgTable("memories", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  scopeTag: text("scope_tag").notNull(), // shared | channel_{id} | user_{id}
  text: text("text").notNull(),
  embedding: vector("embedding").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', text)`),
  source: text("source").notNull().default("slack"), // slack | upload | gdrive | onedrive | notion | research
  sourceRef: text("source_ref"),
  kind: text("kind", { enum: ["fact", "chunk"] }).notNull().default("fact"),
  status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
  supersededBy: bigint("superseded_by", { mode: "number" }),
  createdAt: ts("created_at"),
}, (t) => [
  index("memories_scope_idx").on(t.scopeTag, t.status),
  index("memories_tsv_idx").using("gin", t.tsv),
  index("memories_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

export const memoryEdges = pgTable("memory_edges", {
  fromId: bigint("from_id", { mode: "number" }).notNull(),
  toId: bigint("to_id", { mode: "number" }).notNull(),
  weight: real("weight").notNull().default(1),
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
  status: text("status", { enum: ["pending", "connected", "error"] }).notNull().default("pending"),
  createdAt: ts("created_at"),
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
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  body: text("body").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: ts("created_at"),
});

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
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("api_tokens_hash_idx").on(t.hash)]);

export const syncSources = pgTable("sync_sources", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["gdrive", "onedrive", "notion"] }).notNull(),
  authEnc: text("auth_enc"),
  cursor: text("cursor"),
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
  error: text("error"),
  startedAt: ts("started_at"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

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
