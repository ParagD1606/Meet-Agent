import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { db } from "../db";
import { channelMembers, channels, users } from "../db/schema";
import { log } from "../log";
import { slackClient } from "./client";

type SlackUser = {
  id?: string; deleted?: boolean; is_bot?: boolean; is_owner?: boolean; is_primary_owner?: boolean; is_admin?: boolean;
  real_name?: string; name?: string; profile?: { real_name?: string; display_name?: string; email?: string; title?: string; image_72?: string };
};

export async function upsertSlackUser(u: SlackUser): Promise<void> {
  if (!u.id) return;
  const isBot = Boolean(u.is_bot) || u.id === "USLACKBOT";
  const name = u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || null;
  const values = {
    id: u.id, name, email: u.profile?.email ?? null, title: u.profile?.title || null, avatarUrl: u.profile?.image_72 ?? null,
    isBot, deactivated: Boolean(u.deleted),
  };
  // Role is seeded from Slack flags on first sight only; afterwards the dashboard owns it.
  const role = u.is_owner || u.is_primary_owner ? "owner" : u.is_admin ? "admin" : "member";
  await db.insert(users).values({ ...values, role }).onConflictDoUpdate({ target: users.id, set: values });
}

export async function ensureUser(userId: string): Promise<void> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (row) return;
  try {
    const r = await (await slackClient()).users.info({ user: userId });
    if (r.user) await upsertSlackUser(r.user as SlackUser);
  } catch (err) { log.warn("users.info failed", { userId, error: (err as Error).message }); }
}

export type ChannelHint = { id: string; name?: string; isPrivate?: boolean; isIm?: boolean; botIsMember?: boolean };

export async function upsertChannel(h: ChannelHint): Promise<void> {
  const set: Record<string, unknown> = {};
  if (h.name !== undefined) set.name = h.name;
  if (h.isPrivate !== undefined) set.isPrivate = h.isPrivate;
  if (h.isIm !== undefined) set.isIm = h.isIm;
  if (h.botIsMember !== undefined) set.botIsMember = h.botIsMember;
  await db.insert(channels).values({
    id: h.id, name: h.name ?? null, isPrivate: h.isPrivate ?? false, isIm: h.isIm ?? false, botIsMember: h.botIsMember ?? false,
  }).onConflictDoUpdate({ target: channels.id, set: Object.keys(set).length ? set : { id: h.id } });
}

/** Make sure a `channels` row exists (using Slack's own event hint, then conversations.info for the name). */
export async function ensureChannel(hint: ChannelHint): Promise<void> {
  const [row] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, hint.id));
  if (row) return;
  let info: ChannelHint = hint;
  if (!hint.isIm) {
    try {
      const r = await (await slackClient()).conversations.info({ channel: hint.id });
      const c = r.channel;
      if (c) info = { id: hint.id, name: c.name, isPrivate: Boolean(c.is_private || c.is_mpim), isIm: Boolean(c.is_im), botIsMember: Boolean(c.is_member) };
    } catch (err) { log.warn("conversations.info failed", { channel: hint.id, error: (err as Error).message }); }
  }
  await upsertChannel(info);
}

async function paginate<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const { items, next } = await fetchPage(cursor);
    all.push(...items);
    cursor = next || undefined;
  } while (cursor);
  return all;
}

export async function syncUsers(client: WebClient): Promise<number> {
  const members = await paginate(async (cursor) => {
    const r = await client.users.list({ limit: 200, cursor });
    return { items: (r.members ?? []) as SlackUser[], next: r.response_metadata?.next_cursor };
  });
  for (const m of members) await upsertSlackUser(m);
  return members.length;
}

export async function syncChannelMembers(client: WebClient, channelId: string): Promise<void> {
  const ids = await paginate(async (cursor) => {
    const r = await client.conversations.members({ channel: channelId, limit: 500, cursor });
    return { items: r.members ?? [], next: r.response_metadata?.next_cursor };
  });
  await db.transaction(async (tx) => {
    if (ids.length) await tx.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), notInArray(channelMembers.userId, ids)));
    else await tx.delete(channelMembers).where(eq(channelMembers.channelId, channelId));
    if (ids.length) await tx.insert(channelMembers).values(ids.map((userId) => ({ channelId, userId }))).onConflictDoNothing();
  });
}

export async function syncChannels(client: WebClient): Promise<number> {
  const list = await paginate(async (cursor) => {
    const r = await client.conversations.list({ types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
    return { items: r.channels ?? [], next: r.response_metadata?.next_cursor };
  });
  for (const c of list) {
    if (!c.id) continue;
    await upsertChannel({ id: c.id, name: c.name, isPrivate: Boolean(c.is_private), isIm: false, botIsMember: Boolean(c.is_member) });
    if (c.is_member) {
      try { await syncChannelMembers(client, c.id); } catch (err) { log.warn("conversations.members failed", { channel: c.id, error: (err as Error).message }); }
    }
  }
  // Archived / deleted channels we no longer see must stop being proactive.
  const seen = list.flatMap((c) => (c.id ? [c.id] : []));
  const stale = sql`${channels.isIm} = false`;
  if (seen.length) await db.update(channels).set({ botIsMember: false }).where(and(stale, notInArray(channels.id, seen)));
  return list.length;
}

/** Full resync of users, channels, and (for bot-joined channels) members. Safe to re-run. */
export async function syncWorkspace(): Promise<{ users: number; channels: number }> {
  const client = await slackClient();
  const u = await syncUsers(client);
  const c = await syncChannels(client);
  log.info("slack sync complete", { users: u, channels: c });
  return { users: u, channels: c };
}

export async function setMembership(channelId: string, userId: string, member: boolean): Promise<void> {
  if (member) await db.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing();
  else await db.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

export async function dropChannel(channelId: string): Promise<void> {
  await db.delete(channelMembers).where(eq(channelMembers.channelId, channelId));
  await db.update(channels).set({ botIsMember: false }).where(inArray(channels.id, [channelId]));
}
