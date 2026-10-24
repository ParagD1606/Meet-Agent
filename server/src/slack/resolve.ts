import { eq } from "drizzle-orm";
import { db } from "../db";
import { channels } from "../db/schema";
import { log } from "../log";
import { addFact } from "../memory/facts";
import { scanMemoryText } from "../memory/core-blocks";
import { writeTag } from "../memory/scope";
import { slackClient } from "./client";
import { applyFeedback } from "./feedback";
import { sanitizeForSlack } from "./sanitize";

type Payload = {
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; text?: string; thread_ts?: string };
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Stores "Q: ... A: ..." (a decision) in the thread's write scope (public -> shared, private -> channel_X, DM -> user_X),
 * so the same question is answered from recall next time. Returns false when the text is unsafe or the scope has no tag.
 * Not in a thread? source_ref is the answer message itself.
 */
export async function recordResolution(a: { channelId: string; userId: string; question: string; answer: string; threadTs?: string | null; messageTs?: string }): Promise<boolean> {
  const [ch] = await db.select().from(channels).where(eq(channels.id, a.channelId));
  // unknown channel => private (fail closed), like the turn path
  const tag = writeTag({ channelId: a.channelId, isPrivate: ch?.isPrivate ?? true, isIm: ch?.isIm ?? false, userId: a.userId });
  const text = `Q: ${clip(flat(a.question), 300)} A: ${clip(flat(a.answer), 700)}`;
  if (!tag || scanMemoryText(text)) return false;
  const ref = a.threadTs ?? a.messageTs ?? a.channelId;
  const permalink = a.messageTs
    ? await slackClient().then((c) => c.chat.getPermalink({ channel: a.channelId, message_ts: a.messageTs! })).then((r) => (r as { permalink?: string }).permalink ?? null).catch(() => null)
    : null;
  await addFact({ tag, text, source: "slack", sourceRef: `${a.channelId}:${ref}`, permalink, createdBy: a.userId, factType: "decision", confidence: 0.9, importance: 0.7, agentContext: "primary" });
  return true;
}

/** `brain_resolve_yes` / `brain_resolve_no` clicks. Only the asker's click counts. */
export async function handleResolveAction(payload: Payload, a: { action_id?: string; value?: string }): Promise<boolean> {
  if (a.action_id !== "brain_resolve_yes" && a.action_id !== "brain_resolve_no") return false;
  const clicker = payload.user?.id;
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  let v: { u?: string; q?: string; t?: string | null } = {};
  try { v = JSON.parse(a.value ?? "{}"); } catch { return true; }
  if (!clicker || !channel || !ts || !v.q || (v.u && v.u !== clicker)) return true;
  const slack = await slackClient();
  const done = (text: string) => slack.chat.update({ channel, ts, text, blocks: [] }).catch((e: Error) => log.warn("resolve ack failed", { error: e.message }));
  const threadTs = v.t ?? payload.message?.thread_ts ?? payload.container?.thread_ts ?? null;
  if (a.action_id === "brain_resolve_yes") {
    const answer = flat(payload.message?.text ?? "").replace(/\s*Sources?:.*$/i, "");
    const ok = answer ? await recordResolution({ channelId: channel, userId: clicker, question: v.q, answer, threadTs, messageTs: ts }).catch((e) => { log.warn("resolution save failed", { error: String(e) }); return false; }) : false;
    await done(`${sanitizeForSlack(payload.message?.text ?? "")}\n\n_Marked resolved${ok ? ". I'll answer this instantly next time" : ""}._`);
    return true;
  }
  // Not quite: lower the cited facts (queues them for review), then ask what was off.
  await applyFeedback({ channelId: channel, messageTs: ts, userId: clicker, rating: "down", threadTs });
  await done(sanitizeForSlack(payload.message?.text ?? "") || "_Marked not quite._");
  await slack.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: `<@${clicker}> sorry about that. What was missing or wrong? A line or two and I'll dig again.` });
  return true;
}
