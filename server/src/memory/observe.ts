import { eq, inArray, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { db } from "../db";
import { channels, users } from "../db/schema";
import { log } from "../log";
import { botUserId, slackClient } from "../slack/client";
import { registerBootstrapJobs } from "./bootstrap";
import { alreadySeen, flushIdleAmbient, markPolled } from "./ambient";
import { applyMemorySchedules, bindBoss, loadFreshness } from "./freshness";
import { consolidate } from "./consolidate";
import { backfillContextPrefixes } from "./context-prefix";
import { isTrivialMessage } from "./budget";
import { writeTag } from "./scope";
import { captureTurn, flushIdleCaptures, recoverCaptures } from "./writeback";

const FIRST_RUN_LOOKBACK_S = 24 * 3600;
const BATCH_CHARS = 12_000;
const PAGE = 999; // Slack max per conversations.history page
const MAX_PAGES = 10;

type Msg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string; reply_users?: string[]; app_id?: string };

/** Slack markup -> plain text: `<@U1>` stays as a name later, links keep their label, entities decoded. */
export function plain(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/**
 * Passive learning for one opted-in channel: read Slack history since the watermark (`channels.observed_up_to`), extract
 * durable facts with `createdBy:"observe"` into the channel's OWN write tag only (public -> shared, private -> channel_X),
 * then advance the watermark. Skips: channels not opted in / Quiet / DMs / bot not a member, bot and app messages,
 * threads the bot took part in, trivial chatter. Returns counts of messages considered and facts stored.
 */
export async function observeChannel(channelId: string): Promise<{ messages: number; facts: number }> {
  const none = { messages: 0, facts: 0 };
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.observe === false || ch.isIm || ch.proactivity === "quiet" || !ch.botIsMember) return none;
  const scope = { channelId, isPrivate: ch.isPrivate, isIm: false, userId: null };
  if (!writeTag(scope)) return none;

  const slack = await slackClient();
  const self = await botUserId().catch(() => null);
  const oldest = ch.observedUpTo ?? ((Date.now() / 1000) - FIRST_RUN_LOOKBACK_S).toFixed(6);
  const raw: Msg[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    const res = await slack.conversations.history({ channel: channelId, oldest, limit: PAGE, inclusive: false, cursor });
    raw.push(...((res.messages ?? []) as Msg[]));
    cursor = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
    if (!cursor) break;
    if (page + 1 >= MAX_PAGES) { truncated = true; break; }
  }
  // Slack pages newest-first, so a capped fetch is missing the OLDEST messages and no watermark can resume there without extra state.
  if (truncated) log.warn("observe backlog truncated; oldest messages beyond the page cap are skipped", { channelId, fetched: raw.length });
  const msgs = [...new Map(raw.map((m) => [m.ts, m])).values()].filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!msgs.length) return none;
  const newest = msgs[msgs.length - 1]!.ts!;

  const ids = [...new Set(msgs.flatMap((m) => [m.user, ...(m.text?.match(/<@([A-Z0-9]+)/g)?.map((s) => s.slice(2)) ?? [])]).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name, isBot: users.isBot }).from(users).where(inArray(users.id, ids)) : [];
  const names = new Map(people.map((p) => [p.id, p.name ?? p.id]));
  const bots = new Set(people.filter((p) => p.isBot).map((p) => p.id));

  const seen = await alreadySeen(channelId, msgs.map((m) => m.ts!)); // events already buffered/extracted these
  const lines: string[] = [];
  const polled: string[] = [];
  for (const m of msgs) {
    if (seen.has(m.ts!)) continue;
    if (!m.user || m.bot_id || m.app_id || m.user === self || bots.has(m.user)) continue;
    if (m.subtype && m.subtype !== "thread_broadcast") continue;
    if (self && m.reply_users?.includes(self)) continue; // the bot answered here; that turn was captured already
    const text = plain(m.text ?? "", names);
    if (text.length < 20 || isTrivialMessage(text)) continue;
    lines.push(`${names.get(m.user) ?? m.user}: ${text.slice(0, 1500)}`);
    polled.push(m.ts!);
  }
  await markPolled(channelId, polled); // a late event for the same message is then a no-op

  let facts = 0;
  let batch = "";
  const run = async () => {
    if (!batch.trim()) return;
    facts += await captureTurn({ scope, transcript: batch, sourceRef: channelId, createdBy: "observe", confidence: 0.8, importance: 0.4 });
    batch = "";
  };
  for (const l of lines) {
    if (batch.length + l.length > BATCH_CHARS) await run();
    batch += `${l}\n`;
  }
  await run();
  // captureTurn never throws, so the watermark advances even when extraction found nothing or the LLM was down for a batch.
  await db.update(channels).set({ observedUpTo: newest }).where(eq(channels.id, channelId));
  return { messages: lines.length, facts };
}

/** Polls every observed channel (everything the bot is in unless an admin opted it out). Used by the cron job and "run now". */
export async function observeAll(): Promise<{ channels: number; messages: number; facts: number }> {
  const rows = await db.select({ id: channels.id }).from(channels).where(sql`${channels.observe} is distinct from false and ${channels.botIsMember} and not ${channels.isIm}`);
  const total = { channels: rows.length, messages: 0, facts: 0 };
  for (const r of rows) {
    try {
      const out = await observeChannel(r.id);
      total.messages += out.messages;
      total.facts += out.facts;
      if (out.messages) log.info("observed channel", { channelId: r.id, ...out });
    } catch (e) {
      log.warn("observe failed", { channelId: r.id, err: String(e) });
    }
  }
  return total;
}

export const MEMORY_QUEUES = { observe: "memory-observe", consolidate: "memory-consolidate", reflect: "memory-reflect", backfill: "memory-backfill" } as const;

/** Observe poll (backstop for ambient events), consolidate nightly, flush idle captures; observe/reflect cadence follows the freshness mode. */
export async function registerMemoryJobs(boss: PgBoss): Promise<void> {
  for (const name of Object.values(MEMORY_QUEUES)) await boss.createQueue(name, { name, retryLimit: 0, policy: "short" });
  // timers died with the previous process: flush transcripts still buffered in capture_buffer
  void recoverCaptures().then((n) => { if (n) log.info("recovered buffered captures", { stored: n }); }).catch((e) => log.warn("capture recovery failed", { err: String(e) }));
  bindBoss(boss);
  await loadFreshness().catch((e) => log.warn("freshness load failed", { err: String(e) }));
  void flushIdleAmbient(0).catch((e) => log.warn("ambient recovery failed", { err: String(e) }));
  await boss.work(MEMORY_QUEUES.observe, async () => { await observeAll(); });
  await boss.work(MEMORY_QUEUES.consolidate, async () => {
    log.info("consolidation", { ...(await consolidate()) });
  });
  await boss.work(MEMORY_QUEUES.reflect, async () => {
    const n = await flushIdleCaptures();
    const m = await flushIdleAmbient();
    if (n || m) log.info("reflection sweep stored facts", { n, ambient: m });
  });
  await boss.work(MEMORY_QUEUES.backfill, async () => {
    const n = await backfillContextPrefixes();
    if (n) log.info("context prefixes backfilled", { n });
  });
  await registerBootstrapJobs(boss);
  await boss.schedule(MEMORY_QUEUES.backfill, "*/20 * * * *");
  await boss.schedule(MEMORY_QUEUES.consolidate, "17 3 * * *");
  await applyMemorySchedules(); // observe + reflect crons follow the freshness mode (30 min / 10 min in normal)
}
