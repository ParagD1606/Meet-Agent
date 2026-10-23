import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, channels } from "../db/schema";

export const SHARED_TAG = "shared";

export type SlackScope = { channelId: string; isPrivate: boolean; isIm: boolean; userId: string | null };

/** The single tag a turn WRITES to: public -> shared, private channel -> channel_{id}, DM -> user_{id}. */
export function writeTag(s: SlackScope): string | null {
  if (s.isIm) return s.userId ? `user_${s.userId}` : null;
  if (s.isPrivate) return `channel_${s.channelId}`;
  return SHARED_TAG;
}

/**
 * Every tag a turn may READ: "shared" + its own write tag; a DM additionally reads each private channel
 * its user belongs to (the user's full access surface). Public and private channels never widen.
 */
export async function readTags(s: SlackScope): Promise<string[]> {
  const tags = new Set<string>([SHARED_TAG]);
  const own = writeTag(s);
  if (own) tags.add(own);
  if (s.isIm && s.userId) {
    const rows = await db
      .select({ id: channels.id })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(and(eq(channelMembers.userId, s.userId), eq(channels.isPrivate, true), eq(channels.isIm, false)));
    for (const r of rows) tags.add(`channel_${r.id}`);
  }
  return [...tags];
}
