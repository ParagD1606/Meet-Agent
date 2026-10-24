import { tool, type ToolSet } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { channelMembers, channels, users } from "../db/schema";
import { untrusted } from "../guards";
import { log } from "../log";
import { slackClient } from "./client";

/** Who is asking. Everything here is checked against THIS person's channel memberships, never the bot's. */
export type Asker = { userId: string | null; /** a public-channel turn: private channels stay out of reach (the answer is posted publicly) */ publicOnly?: boolean };

export type ChannelHit = { channelId: string; channel: string; ts: string; user: string; text: string; threadTs?: string };

const MAX_CHANNELS = 8;
const HISTORY_PER_CHANNEL = 100;
const SNIPPET = 400;

/**
 * Channels this person may see through the bot: real channels (never DMs) where BOTH the bot and the asker are
 * members. Membership comes from our synced `channel_members`, so a private channel is invisible unless the asker is in it.
 * Fails closed: unknown asker or unknown channel => nothing.
 */
export async function accessibleChannels(asker: Asker): Promise<{ id: string; name: string | null; isPrivate: boolean }[]> {
  if (!asker.userId) return [];
  const mine = await db.select({ id: channelMembers.channelId }).from(channelMembers).where(eq(channelMembers.userId, asker.userId));
  if (!mine.length) return [];
  return db.select({ id: channels.id, name: channels.name, isPrivate: channels.isPrivate }).from(channels)
    .where(and(inArray(channels.id, mine.map((m) => m.id)), eq(channels.botIsMember, true), eq(channels.isIm, false), asker.publicOnly ? eq(channels.isPrivate, false) : undefined));
}

export async function canReadChannel(asker: Asker, channelId: string): Promise<boolean> {
  return (await accessibleChannels(asker)).some((c) => c.id === channelId);
}

const terms = (q: string) => q.toLowerCase().split(/[^\p{L}\p{N}_#-]+/u).filter((t) => t.length > 1).slice(0, 8);

async function names(ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  for (const r of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) m.set(r.id, r.name ?? r.id);
  return m;
}

/** Keyword search over recent history of the channels the asker belongs to (optionally narrowed by name). */
export async function searchSlackChannels(a: { asker: Asker; query: string; channel?: string; limit?: number }): Promise<{ hits: ChannelHit[]; searched: number }> {
  let pool = await accessibleChannels(a.asker);
  if (a.channel) {
    const want = a.channel.replace(/^#/, "").toLowerCase();
    pool = pool.filter((c) => c.id === a.channel || c.name?.toLowerCase() === want);
  }
  const q = terms(a.query);
  // channels whose name matches the query are searched first
  pool.sort((x, y) => Number(q.some((t) => y.name?.toLowerCase().includes(t))) - Number(q.some((t) => x.name?.toLowerCase().includes(t))));
  pool = pool.slice(0, MAX_CHANNELS);
  const limit = Math.min(a.limit ?? 10, 20);
  const slack = await slackClient();
  const raw: (Omit<ChannelHit, "user"> & { uid: string })[] = [];
  for (const c of pool) {
    try {
      const r = await slack.conversations.history({ channel: c.id, limit: HISTORY_PER_CHANNEL });
      for (const m of (r.messages ?? []) as { user?: string; text?: string; ts?: string; thread_ts?: string }[]) {
        const text = m.text ?? "";
        if (!m.ts || !text || (q.length && !q.some((t) => text.toLowerCase().includes(t)))) continue;
        raw.push({ channelId: c.id, channel: c.name ?? c.id, ts: m.ts, uid: m.user ?? "app", text: text.slice(0, SNIPPET), threadTs: m.thread_ts });
      }
    } catch (e) { log.warn("slack search: history failed", { channel: c.id, error: String(e) }); }
  }
  raw.sort((x, y) => Number(y.ts) - Number(x.ts));
  const top = raw.slice(0, limit);
  const nm = await names([...new Set(top.map((h) => h.uid))]);
  return { hits: top.map(({ uid, ...h }) => ({ ...h, user: nm.get(uid) ?? uid })), searched: pool.length };
}

export type RealtimeHit = { channelId: string; ts: string; user: string; text: string; permalink?: string };

/** Slack error codes that mean the app/user has not granted Real-time Search (or the action token is unusable). */
const RTS_DENIED = /missing_scope|not_allowed_token_type|invalid_action_token|action_token|access_denied|not_authed|feature_not_enabled|restricted_action|no_permission|ekm/i;

/**
 * Slack Real-time Search (assistant.search.context), read-only and scoped by Slack to what the ASKER can see: it needs the
 * short-lived `action_token` from the asker's own event, so we never search with more access than they have. Never throws.
 */
export async function searchSlackRealtime(a: { actionToken?: string | null; query: string; limit?: number; /** DM turns only: also search private channels, group DMs and DMs */ allowPrivate?: boolean }): Promise<{ ok: true; hits: RealtimeHit[]; sawPrivate: boolean } | { ok: false; error: string }> {
  if (!a.actionToken) return { ok: false, error: "Live Slack search needs a fresh request from the user (no search token on this turn, e.g. a scheduled or approval follow-up). Use search_slack_channels instead." };
  try {
    const r = (await (await slackClient()).apiCall("assistant.search.context", {
      query: a.query, action_token: a.actionToken, content_types: ["messages"], channel_types: a.allowPrivate ? ["public_channel", "private_channel", "mpim", "im"] : ["public_channel"],
      limit: Math.min(a.limit ?? 10, 20), include_bots: false,
    })) as { results?: { messages?: Record<string, unknown>[] } };
    const msgs = r.results?.messages ?? [];
    const sawPrivate = msgs.some((m) => m.channel_type !== "public_channel"); // unknown type counts as private
    const hits = msgs.map((m) => ({
      channelId: String(m.channel_id ?? ""), ts: String(m.message_ts ?? m.ts ?? ""), user: String(m.author_name ?? m.author_user_id ?? "unknown"),
      text: String(m.content ?? m.text ?? "").slice(0, SNIPPET), permalink: typeof m.permalink === "string" ? m.permalink : undefined,
    })).filter((h) => h.text);
    return { ok: true, hits, sawPrivate };
  } catch (e) {
    const code = (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.message : String(e));
    log.warn("slack realtime search failed", { error: code });
    if (RTS_DENIED.test(code)) return { ok: false, error: `Live Slack search is not enabled for you or this workspace (${code}). An admin must grant the search:read scopes and you must have consented; use search_slack_channels meanwhile.` };
    return { ok: false, error: `Live Slack search failed (${code}). Try search_slack_channels instead.` };
  }
}

/** A thread (or the single message) from a channel the asker belongs to. */
export async function readThread(a: { asker: Asker; channelId: string; threadTs: string; limit?: number }): Promise<{ ok: true; messages: { user: string; ts: string; text: string }[] } | { ok: false; error: string }> {
  if (!(await canReadChannel(a.asker, a.channelId))) return { ok: false, error: "You are not a member of that channel, or I am not in it, so I can't read it for you." };
  try {
    const r = await (await slackClient()).conversations.replies({ channel: a.channelId, ts: a.threadTs, limit: Math.min(a.limit ?? 30, 60) });
    const msgs = (r.messages ?? []) as { user?: string; text?: string; ts?: string }[];
    const nm = await names([...new Set(msgs.flatMap((m) => (m.user ? [m.user] : [])))]);
    return { ok: true, messages: msgs.filter((m) => m.ts && m.text).map((m) => ({ user: nm.get(m.user ?? "") ?? m.user ?? "app", ts: m.ts!, text: m.text!.slice(0, 1500) })) };
  } catch (e) {
    return { ok: false, error: `Could not read that thread: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** ai-SDK tools for the `slack_search` family. */
export function slackSearchTools(ctx: { userId: string | null; actionToken?: string | null; isIm?: boolean; isPrivate?: boolean; touchedPrivateData?: boolean }): ToolSet {
  const asker = { userId: ctx.userId, publicOnly: !ctx.isIm && !ctx.isPrivate };
  const taint = () => { ctx.touchedPrivateData = true; }; // nothing from this turn may be learned or sent to the web
  return {
    search_slack_channels: tool({
      description: "Keyword-search recent messages in channels you (the asker) belong to. Optionally narrow to one channel name.",
      inputSchema: z.object({ query: z.string().min(1).max(200), channel: z.string().max(80).optional(), limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ query, channel, limit }) => {
        const { hits, searched } = await searchSlackChannels({ asker, query, channel, limit });
        if (!asker.publicOnly && hits.length) taint(); // may include private-channel text
        if (!hits.length) return searched ? "No matching recent messages in your channels." : "No channels available to search for you.";
        return untrusted(hits.map((h) => `#${h.channel} ${h.user} [thread ${h.threadTs ?? h.ts} in ${h.channelId}]: ${h.text}`).join("\n"), "slack-search");
      },
    }),
    search_slack_live: tool({
      description: "Live, up-to-date search across everything the asker can see in Slack (Real-time Search, read-only, includes channels the bot is not in). Prefer it over search_slack_channels for fresh or broad questions; falls back with a clear error if unavailable.",
      inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ query, limit }) => {
        const r = await searchSlackRealtime({ actionToken: ctx.actionToken, query, limit, allowPrivate: !!ctx.isIm });
        if (!r.ok) return `ERROR: ${r.error}`;
        if (r.sawPrivate) taint();
        if (!r.hits.length) return "No matching messages.";
        return untrusted(r.hits.map((h) => `${h.user} [thread ${h.ts} in ${h.channelId}]${h.permalink ? ` ${h.permalink}` : ""}: ${h.text}`).join("\n"), "slack-search");
      },
    }),
    read_thread: tool({
      description: "Read a Slack thread by channel id and thread ts, only in channels the asker belongs to.",
      inputSchema: z.object({ channelId: z.string().min(1), threadTs: z.string().min(1), limit: z.number().int().min(1).max(60).optional() }),
      execute: async ({ channelId, threadTs, limit }) => {
        const r = await readThread({ asker, channelId, threadTs, limit });
        if (!r.ok) return r.error;
        if (!asker.publicOnly) taint();
        return untrusted(r.messages.map((m) => `${m.user}: ${m.text}`).join("\n"), "slack-thread");
      },
    }),
  };
}
