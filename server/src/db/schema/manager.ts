import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  status: text("status", { enum: ["open", "done", "dropped", "overdue"] }).notNull().default("open"),
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  nudgeCount: integer("nudge_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("commitments_source_uniq").on(t.sourceRef),
  index("commitments_owner_idx").on(t.ownerId, t.status),
  index("commitments_scope_idx").on(t.scopeTag, t.status),
]);

/** Risks already posted (one row per risk key), so the daily scan never repeats itself. */
export const managerRisks = pgTable("manager_risks", {
  key: text("key").primaryKey(),
  postedAt: ts("posted_at"),
});
