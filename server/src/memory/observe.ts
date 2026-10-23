import { eq, inArray } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { db } from "../db";
import { channels, users } from "../db/schema";
import { log } from "../log";
import { botUserId, slackClient } from "../slack/client";
import { consolidate } from "./consolidate";
import { isTrivialMessage } from "./budget";
import { writeTag } from "./scope";
import { captureTurn, flushIdleCaptures } from "./writeback";

const FIRST_RUN_LOOKBACK_S = 24 * 3600;
const BATCH_CHARS = 12_000;
const PAGE = 200;

type Msg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string; reply_users?: string[]; app_id?: string };

/** Slack markup -> plain text: `<@U1>` stays as a name later, links keep their label, entities decoded. */
function plain(text: string, names: Map<string, string>): string {
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
  if (!ch || !ch.observe || ch.isIm || ch.proactivity === "quiet" || !ch.botIsMember) return none;
  const scope = { channelId, isPrivate: ch.isPrivate, isIm: false, userId: null };
  if (!writeTag(scope)) return none;

  const slack = await slackClient();
  const self = await botUserId().catch(() => null);
  const oldest = ch.observedUpTo ?? ((Date.now() / 1000) - FIRST_RUN_LOOKBACK_S).toFixed(6);
  const res = await slack.conversations.history({ channel: channelId, oldest, limit: PAGE, inclusive: false });
  const msgs = ((res.messages ?? []) as Msg[]).filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!msgs.length) return none;
  const newest = msgs[msgs.length - 1]!.ts!;

  const ids = [...new Set(msgs.flatMap((m) => [m.user, ...(m.text?.match(/<@([A-Z0-9]+)/g)?.map((s) => s.slice(2)) ?? [])]).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name, isBot: users.isBot }).from(users).where(inArray(users.id, ids)) : [];
  const names = new Map(people.map((p) => [p.id, p.name ?? p.id]));
  const bots = new Set(people.filter((p) => p.isBot).map((p) => p.id));

  const lines: string[] = [];
  for (const m of msgs) {
    if (!m.user || m.bot_id || m.app_id || m.user === self || bots.has(m.user)) continue;
    if (m.subtype && m.subtype !== "thread_broadcast") continue;
    if (self && m.reply_users?.includes(self)) continue; // the bot answered here; that turn was captured already
    const text = plain(m.text ?? "", names);
    if (text.length < 20 || isTrivialMessage(text)) continue;
    lines.push(`${names.get(m.user) ?? m.user}: ${text.slice(0, 1500)}`);
  }

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

export const MEMORY_QUEUES = { observe: "memory-observe", consolidate: "memory-consolidate", reflect: "memory-reflect" } as const;

/** Observe every 30 min (opted-in channels), consolidate nightly, flush idle thread captures every 10 min. */
export async function registerMemoryJobs(boss: PgBoss): Promise<void> {
  for (const name of Object.values(MEMORY_QUEUES)) await boss.createQueue(name, { name, retryLimit: 0, policy: "short" });
  await boss.work(MEMORY_QUEUES.observe, async () => {
    const rows = await db.select({ id: channels.id }).from(channels).where(eq(channels.observe, true));
    for (const r of rows) {
      try {
        const out = await observeChannel(r.id);
        if (out.messages) log.info("observed channel", { channelId: r.id, ...out });
      } catch (e) {
        log.warn("observe failed", { channelId: r.id, err: String(e) });
      }
    }
  });
  await boss.work(MEMORY_QUEUES.consolidate, async () => {
    log.info("consolidation", { ...(await consolidate()) });
  });
  await boss.work(MEMORY_QUEUES.reflect, async () => {
    const n = await flushIdleCaptures();
    if (n) log.info("reflection sweep stored facts", { n });
  });
  await boss.schedule(MEMORY_QUEUES.observe, "*/30 * * * *");
  await boss.schedule(MEMORY_QUEUES.consolidate, "17 3 * * *");
  await boss.schedule(MEMORY_QUEUES.reflect, "*/10 * * * *");
}
