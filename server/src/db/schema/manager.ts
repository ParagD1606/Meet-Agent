import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true }).defaultNow().notNull();

/** Who promised what by when. `scopeTag` is the memory scope the commitment was made in (shared | channel_{id} | user_{id}) and gates every read. */
export const commitments = pgTable("commitments", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"), // Slack user id; null when the owner could not be resolved
  ownerName: text("owner_name"),
  text: text("text").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  sourceType: text("source_type", { enum: ["fact", "meeting", "message", "ticket"] }).notNull(),
  sourceRef: text("source_ref").notNull(), // dedupe key, e.g. fact:12, meeting:mt_x:3, episode:e1:0
  permalink: text("permalink"),
  channelId: text("channel_id"),
  threadTs: text("thread_ts"),
  scopeTag: text("scope_tag").notNull(),
  status: text("status", { enum: ["open", "done", "dropped", "overdue", "in_progress"] }).notNull().default("open"),
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  nudgeCount: integer("nudge_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: ts("created_at"),
  assignerId: text("assigner_id"), // Slack user id of whoever gave the task (message author)
  sourceTs: text("source_ts"), // Slack ts of the originating message (edit/delete sync)
  sourceHash: text("source_hash"), // hash of that message's raw text (skips no-op message_changed events)
  priority: text("priority", { enum: ["normal", "urgent"] }).notNull().default("normal"),
  memoryId: integer("memory_id"), // the active memory fact that mirrors this task (superseded on every status change)
  titleKey: text("title_key"), // normalized title: dedupe by owner + title + channel
  externalRefs: jsonb("external_refs").$type<{ provider: string; id: string; url: string }[]>().notNull().default([]), // cards/issues this task was pushed to
}, (t) => [
  index("commitments_dedupe_idx").on(t.ownerId, t.titleKey, t.channelId),
  index("commitments_source_ts_idx").on(t.channelId, t.sourceTs),
  index("commitments_thread_idx").on(t.channelId, t.threadTs),
  uniqueIndex("commitments_source_uniq").on(t.sourceRef),
  index("commitments_owner_idx").on(t.ownerId, t.status),
  index("commitments_scope_idx").on(t.scopeTag, t.status),
]);

/** "Remind me / follow up with @X" DMs. target null = remind the owner; otherwise DMs target only after the owner consented (status proposed -> pending). */
export const followUps = pgTable("follow_ups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  targetId: text("target_id"),
  text: text("text").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  repeatDays: integer("repeat_days"),
  status: text("status", { enum: ["proposed", "pending", "sent", "cancelled", "failed"] }).notNull().default("pending"),
  originChannelId: text("origin_channel_id"),
  originThreadTs: text("origin_thread_ts"),
  sendCount: integer("send_count").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: ts("created_at"),
}, (t) => [index("follow_ups_due_idx").on(t.status, t.dueAt), index("follow_ups_owner_idx").on(t.ownerId, t.status)]);

/** Risks already posted (one row per risk key), so the daily scan never repeats itself. */
export const managerRisks = pgTable("manager_risks", {
  key: text("key").primaryKey(),
  postedAt: ts("posted_at"),
}, (t) => [index("manager_risks_posted_at_idx").on(t.postedAt)]);

/** Audit of every push of a task to an external board (Trello / GitHub Issues); `ok` rows double as the idempotency record. */
export const integrationPushes = pgTable("integration_pushes", {
  id: text("id").primaryKey(),
  at: ts("at"),
  userId: text("user_id").notNull(),
  target: text("target").notNull(),
  taskRef: text("task_ref").notNull(), // commitment:<id> | meeting:<meetingId>:<itemId>
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  status: text("status", { enum: ["ok", "failed"] }).notNull(),
  error: text("error"),
}, (t) => [index("integration_pushes_task_idx").on(t.target, t.taskRef, t.status)]);
