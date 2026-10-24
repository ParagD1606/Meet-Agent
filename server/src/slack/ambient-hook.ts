import { dropAmbient, editAmbient, recordAmbient } from "../memory/ambient";
import { applyThreadReply, captureTaskMessage, refreshTaskMessage, retireTaskMessage } from "../manager/capture";
import { upsertChannel } from "./sync";
import type { SlackMessageEvent } from "./routing";

type Privacy = (ev: SlackMessageEvent) => Promise<{ isPrivate: boolean; isIm: boolean }>;

const inflight = new Set<Promise<unknown>>();
/** Task capture runs off the event path (it may call a model); tests and shutdown await this. */
export const settleAmbient = async () => { await Promise.allSettled([...inflight]); };
const bg = (p: Promise<unknown>) => { const q = p.catch(() => {}).finally(() => inflight.delete(q)); inflight.add(q); };

/**
 * Feeds channel messages to ambient capture (memory/ambient.ts). Skips DMs/group DMs, bots, and messages bound for the bot
 * (the turn pipeline captures those). Handles message_changed / message_deleted for still-buffered messages.
 */
export async function ambientHook(ev: SlackMessageEvent & Record<string, any>, me: string, route: string, privacyOf: Privacy): Promise<void> {
  if (ev.channel_type === "im" || ev.channel_type === "mpim" || ev.channel.startsWith("D")) return;
  if (ev.subtype === "message_deleted") {
    if (ev.deleted_ts) { await dropAmbient(ev.channel, ev.deleted_ts); await retireTaskMessage(ev.channel, ev.deleted_ts); }
    return;
  }
  if (ev.subtype === "message_changed") {
    const m = ev.message as { ts?: string; thread_ts?: string; text?: string; user?: string; bot_id?: string } | undefined;
    if (m?.ts && m.user && !m.bot_id && m.user !== me) {
      await editAmbient(ev.channel, m.ts, m.text ?? "");
      bg(refreshTaskMessage({ channel: ev.channel, ts: m.ts, thread_ts: m.thread_ts, user: m.user, text: m.text ?? "" }));
    }
    return;
  }
  if (route === "turn" || ev.bot_id || !ev.user || ev.user === me || (ev.subtype && ev.subtype !== "thread_broadcast")) return;
  const { isPrivate, isIm } = await privacyOf(ev);
  if (isIm) return;
  await upsertChannel({ id: ev.channel, isPrivate, isIm: false, botIsMember: true }); // a delivered message implies membership
  await recordAmbient({ channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: ev.text ?? "" });
  // real-time task capture and thread-reply status updates (short replies like "done" are too trivial for the fact buffer)
  const t = { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: ev.text ?? "" };
  bg((async () => { // a reply that updates a thread's task ("I'll take this") is not a new task
    if (ev.thread_ts && ev.thread_ts !== ev.ts && (await applyThreadReply(t)) !== "none") return;
    await captureTaskMessage(t);
  })());
}
