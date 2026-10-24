import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { channels, users } from "../db/schema";
import { log } from "../log";
import { applyThreadReply, captureTaskMessage } from "../manager/capture";
import { getSetting, putSetting } from "../manager/commitments";
import { botUserId, slackClient } from "../slack/client";
import { alreadySeen, flushAmbient, recordAmbient } from "./ambient";

/**
 * History backfill: reads conversations.history (+ replies of threaded messages) back `memory_backfill_days` (default 30, max 90)
 * through the SAME buffering/extraction as live events: (channel, ts) in ambient_messages is the idempotency ledger, so a
 * message already seen live, polled or backfilled is never added twice, and commitments dedupe on msg:<channel>:<ts>.
 * Public -> shared, private -> channel_X only (recordAmbient / captureTaskMessage apply the same scope rules).
 * Resumable: the next page cursor is stored per channel in settings (`backfill:<channel>`); a run stops when its call budget is
 * spent and the next run (hourly job, join, "run now") continues from there. Slack calls are paced (workspace cap) and obey Retry-After.
 */
export const backfillDeps = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  /** Minimum gap between Slack calls: ~50/min for the whole workspace (Tier 3). */
  minGapMs: 1200,
};

const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const backfillDays = async (): Promise<number> => {
  const v = Number(await getSetting<number>("memory_backfill_days"));
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_DAYS, Math.floor(v)) : DEFAULT_DAYS;
};

type State = { oldest: string; cursor?: string; done?: boolean; messages: number };
const key = (channelId: string) => `backfill:${channelId}`;
export const getBackfillState = (channelId: string) => getSetting<State>(key(channelId));

let lastCall = 0;
class OutOfBudget extends Error {}
type Budget = { calls: number };

/** One paced, budgeted Slack call. 429 / ratelimited: waits Retry-After (default 2s) and retries up to 4 times. */
async function call<T>(budget: Budget, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (budget.calls <= 0) throw new OutOfBudget();
    budget.calls--;
    const wait = lastCall + backfillDeps.minGapMs - Date.now();
    if (wait > 0) await backfillDeps.sleep(wait);
    lastCall = Date.now();
    try { return await fn(); }
    catch (e) {
      const err = e as { code?: string; data?: { error?: string; retryAfter?: number }; retryAfter?: number; statusCode?: number };
      const limited = err.code === "slack_webapi_rate_limited" || err.data?.error === "ratelimited" || err.statusCode === 429;
      if (!limited || attempt >= 4) throw e;
      await backfillDeps.sleep((err.retryAfter ?? err.data?.retryAfter ?? 2) * 1000);
    }
  }
}

type Msg = { ts?: string; thread_ts?: string; user?: string; bot_id?: string; app_id?: string; text?: string; subtype?: string; reply_count?: number };
const PAGE = 200;

export type BackfillResult = { messages: number; tasks: number; pages: number; done: boolean };

/** Backfills one channel until done or the call budget runs out. Idempotent and resumable. */
export async function backfillChannel(channelId: string, o: { budget?: Budget; force?: boolean } = {}): Promise<BackfillResult> {
  const out: BackfillResult = { messages: 0, tasks: 0, pages: 0, done: false };
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.isIm || !ch.botIsMember || ch.observe === false || ch.proactivity === "quiet") return { ...out, done: true };
  let state = await getBackfillState(channelId);
  if (state?.done && !o.force) return { ...out, done: true };
  if (!state || o.force) state = { oldest: (Date.now() / 1000 - (await backfillDays()) * 86_400).toFixed(6), messages: 0 };
  const base = state.messages;
  const budget = o.budget ?? { calls: Number(process.env.MEMORY_BACKFILL_CALLS_PER_RUN ?? 20) };
  const slack = await slackClient();
  const self = await botUserId().catch(() => null);
  const bots = new Set((await db.select({ id: users.id }).from(users).where(eq(users.isBot, true))).map((u) => u.id));

  const handle = async (m: Msg, seen: Set<string>): Promise<void> => {
    if (!m.ts || seen.has(m.ts) || !m.user || m.bot_id || m.app_id || m.user === self || bots.has(m.user)) return;
    if (m.subtype && m.subtype !== "thread_broadcast") return;
    const ev = { channel: channelId, ts: m.ts, thread_ts: m.thread_ts, user: m.user, text: m.text ?? "" };
    // task capture first: if we die before the ledger insert below, the retry re-runs it (commitments dedupe on source_ref)
    const reply = !!m.thread_ts && m.thread_ts !== m.ts;
    if (!(reply && (await applyThreadReply(ev)) !== "none")) out.tasks += await captureTaskMessage(ev, { noChase: true });
    if (await recordAmbient(ev)) out.messages++;
  };

  try {
    for (;;) {
      const res = await call(budget, () => slack.conversations.history({ channel: channelId, oldest: state!.oldest, limit: PAGE, inclusive: false, cursor: state!.cursor }));
      const msgs = ((res.messages ?? []) as Msg[]).filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
      const seen = await alreadySeen(channelId, msgs.map((m) => m.ts!));
      for (const m of msgs) {
        await handle(m, seen);
        if (m.reply_count && m.thread_ts === m.ts) {
          let rc: string | undefined;
          do {
            const r = await call(budget, () => slack.conversations.replies({ channel: channelId, ts: m.ts!, oldest: state!.oldest, limit: PAGE, cursor: rc }));
            const replies = ((r.messages ?? []) as Msg[]).filter((x) => x.ts && x.ts !== m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
            const rseen = await alreadySeen(channelId, replies.map((x) => x.ts!));
            for (const x of replies) await handle({ ...x, thread_ts: x.thread_ts ?? m.ts }, rseen);
            rc = r.has_more ? r.response_metadata?.next_cursor || undefined : undefined;
          } while (rc);
        }
      }
      out.pages++;
      const next = res.has_more ? res.response_metadata?.next_cursor || undefined : undefined;
      state = { ...state, cursor: next, done: !next, messages: base + out.messages };
      await putSetting(key(channelId), state);
      if (!next) break;
    }
  } catch (e) {
    if (!(e instanceof OutOfBudget)) log.warn("history backfill failed", { channelId, err: String(e).slice(0, 200) });
  }
  out.done = !!state.done;
  await flushAmbient(channelId).catch((e) => log.warn("backfill flush failed", { channelId, err: String(e) }));
  return out;
}

/** Every observed channel the bot is in that is not finished yet, one shared call budget. */
export async function backfillAll(o: { calls?: number; force?: boolean } = {}): Promise<{ channels: number; messages: number; tasks: number; remaining: number }> {
  const rows = await db.select({ id: channels.id }).from(channels).where(sql`${channels.observe} is distinct from false and ${channels.botIsMember} and not ${channels.isIm}`);
  const budget = { calls: o.calls ?? Number(process.env.MEMORY_BACKFILL_CALLS_PER_RUN ?? 20) };
  const total = { channels: 0, messages: 0, tasks: 0, remaining: 0 };
  for (const r of rows) {
    if (budget.calls <= 0) { if (!(await getBackfillState(r.id))?.done) total.remaining++; continue; }
    const res = await backfillChannel(r.id, { budget, force: o.force });
    if (res.pages || res.messages) total.channels++;
    total.messages += res.messages;
    total.tasks += res.tasks;
    if (!res.done) total.remaining++;
  }
  return total;
}

/** Bot joined a channel: backfill it soon via pg-boss (no-op when jobs are not running; the hourly job picks it up). */
export async function requestBackfill(channelId: string): Promise<boolean> {
  const { jobsStarted, getBoss } = await import("../jobs");
  if (!jobsStarted()) return false;
  await getBoss().send("memory-backfill-history", { channelId }, { singletonKey: channelId });
  return true;
}
