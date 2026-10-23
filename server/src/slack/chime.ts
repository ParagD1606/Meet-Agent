import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { log } from "../log";
import { addReaction, slackClient } from "./client";
import { reserveChime } from "./chime-budget";
import { deps } from "./deps";
import { channelIsProactive } from "./proactivity";
import { stripMention, type SlackMessageEvent } from "./routing";
import { triageDetailed, type TriageInput } from "./triage";

export type ChimeOutcome = "quiet" | "pass" | "ack" | "answered" | "investigated" | "budget";

type HistMsg = { user?: string; bot_id?: string; text?: string; ts?: string };

async function loadHistory(ev: SlackMessageEvent, context: "thread" | "channel", botId: string): Promise<NonNullable<TriageInput["history"]>> {
  try {
    const c = await slackClient();
    const msgs: HistMsg[] = context === "thread"
      ? ((await c.conversations.replies({ channel: ev.channel, ts: ev.thread_ts!, limit: 12 })).messages ?? [])
      : [...((await c.conversations.history({ channel: ev.channel, limit: 9 })).messages ?? [])].reverse();
    const prior = msgs.filter((m) => m.ts !== ev.ts && m.text);
    const ids = [...new Set(prior.flatMap((m) => (m.user ? [m.user] : [])))];
    const names = new Map<string, string>();
    if (ids.length) for (const r of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) names.set(r.id, r.name ?? r.id);
    return prior.map((m) => ({
      user: m.user ? (m.user === botId ? "Company Brain" : names.get(m.user) ?? m.user) : "app",
      text: stripMention(m.text ?? "", botId),
      isBot: Boolean(m.bot_id) || m.user === botId,
    }));
  } catch (err) {
    log.warn("triage history unavailable", { channel: ev.channel, error: (err as Error).message });
    return [];
  }
}

/**
 * Unprompted (no @mention) message in a channel/thread: proactivity gate -> triage -> chime budget -> turn.
 * Proactive turns are read-only and org-connections-only: the bot must never act with a person's
 * private credentials or write anything on a message nobody asked it to handle.
 */
export async function handleChannelMessage(
  ev: SlackMessageEvent,
  o: { context: "thread" | "channel"; botUserId: string; channelName?: string; isPrivate: boolean },
): Promise<ChimeOutcome> {
  if (!(await channelIsProactive(ev.channel))) return "quiet";
  const [speaker] = ev.user ? await db.select({ name: users.name }).from(users).where(eq(users.id, ev.user)) : [];
  const history = await loadHistory(ev, o.context, o.botUserId);
  const t = await triageDetailed({
    text: stripMention(ev.text ?? "", o.botUserId), context: o.context, speaker: speaker?.name ?? ev.user,
    channelName: o.channelName, history,
  });
  log.info("triage", { channel: ev.channel, decision: t.decision, source: t.source });

  if (t.decision === "PASS") return "pass";
  if (t.decision === "ACK") {
    await addReaction(ev.channel, ev.ts, t.emoji ?? "eyes");
    return "ack";
  }
  const threadTs = ev.thread_ts ?? ev.ts;
  const budget = await reserveChime(ev.channel, threadTs);
  if (!budget.allowed) {
    log.info("chime suppressed", { channel: ev.channel, reason: budget.reason });
    return "budget";
  }
  try {
    await deps.runTurn({
      trigger: "chime", channelId: ev.channel, threadTs, ts: ev.ts, userId: ev.user ?? null,
      text: t.decision === "INVESTIGATE"
        ? `${stripMention(ev.text ?? "", o.botUserId)}\n\n[triage note: ${t.reason}]`
        : stripMention(ev.text ?? "", o.botUserId),
      isPrivate: o.isPrivate, isIm: false, readOnly: true, orgConnectionsOnly: true,
    });
  } catch (err) {
    log.error("chime turn failed", { channel: ev.channel, error: (err as Error).message });
  }
  return t.decision === "ANSWER" ? "answered" : "investigated";
}
