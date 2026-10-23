import { index, pgTable, text, timestamp, bigserial, uniqueIndex } from "drizzle-orm/pg-core";

/** 👍/👎 reactions on messages the bot authored. One row per (message, user); changing your mind updates it. */
export const messageFeedback = pgTable("message_feedback", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  channelId: text("channel_id").notNull(),
  messageTs: text("message_ts").notNull(),
  userId: text("user_id").notNull(),
  rating: text("rating", { enum: ["up", "down"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("message_feedback_uniq").on(t.channelId, t.messageTs, t.userId),
  index("message_feedback_channel_idx").on(t.channelId),
]);
