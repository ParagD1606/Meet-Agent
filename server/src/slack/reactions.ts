import { sql } from "drizzle-orm";
import { db } from "../db";
import { messageFeedback } from "../db/schema";
import { addReaction, removeReaction } from "./client";

export const ack = (channel: string, ts: string) => addReaction(channel, ts, "eyes");
export async function done(channel: string, ts: string, ok = true) {
  await removeReaction(channel, ts, "eyes");
  await addReaction(channel, ts, ok ? "white_check_mark" : "warning");
}

const UP = new Set(["+1", "thumbsup", "thumbsup_all"]);
const DOWN = new Set(["-1", "thumbsdown"]);

/** Maps a Slack reaction name (skin-tone suffix stripped) to a rating, or null if it isn't feedback. */
export function ratingFor(reaction: string): "up" | "down" | null {
  const base = reaction.replace(/::skin-tone-\d$/, "");
  return UP.has(base) ? "up" : DOWN.has(base) ? "down" : null;
}

export async function recordFeedback(a: { channelId: string; messageTs: string; userId: string; rating: "up" | "down" }) {
  await db.insert(messageFeedback).values(a).onConflictDoUpdate({
    target: [messageFeedback.channelId, messageFeedback.messageTs, messageFeedback.userId],
    set: { rating: a.rating, createdAt: sql`now()` },
  });
}
