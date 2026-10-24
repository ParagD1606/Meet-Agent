import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { log } from "../log";
import { checkRate } from "../limits";
import { addReaction, slackClient } from "./client";
import { reserveChime } from "./chime-budget";
import { deps } from "./deps";
import { channelIsProactive } from "./proactivity";
import { AUTOREPLY_MIN_SIMILARITY, bestSimilarity, channelFeatures, consultMemory, nudgeText, sendEphemeral, strongDecision, SUGGESTION_TEXT } from "./proactive-features";
import { stripMention, type SlackMessageEvent } from "./routing";
import { triageDetailed, type TriageInput } from "./triage";
import { sampleTriage, triagePrefilter } from "./triage-prefilter";

export type ChimeOutcome = "quiet" | "pass" | "ack" | "answered" | "investigated" | "budget" | "filtered" | "sampled" | "rate_limited" | "nudged" | "suggested";

type HistMsg = { user?: string; bot_id?: string; text?: string; ts?: string };

type Loaded = { history: NonNullable<TriageInput["history"]>; lastSpeakerId: string | null; lastWasBot: boolean };

async function loadHistory(ev: SlackMessageEvent, context: "thread" | "channel", botId: string): Promise<Loaded> {
  try {
    const c = await slackClient();
    const msgs: HistMsg[] = context === "thread"
      ? ((await c.conversations.replies({ channel: ev.channel, ts: ev.thread_ts!, limit: 12 })).messages ?? [])
      : [...((await c.conversations.history({ channel: ev.channel, limit: 9 })).messages ?? [])].reverse();
    const prior = msgs.filter((m) => m.ts !== ev.ts && m.text);
    const ids = [...new Set(prior.flatMap((m) => (m.user ? [m.user] : [])))];
    const names = new Map<string, string>();
    if (ids.length) for (const r of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) names.set(r.id, r.name ?? r.id);
    const history = prior.map((m) => ({
      user: m.user ? (m.user === botId ? "Company Brain" : names.get(m.user) ?? m.user) : "app",
      text: stripMention(m.text ?? "", botId),
      isBot: Boolean(m.bot_id) || m.user === botId,
    }));
    const lastRaw = prior[prior.length - 1];
    return { history, lastSpeakerId: lastRaw?.user ?? null, lastWasBot: Boolean(lastRaw && (lastRaw.bot_id || lastRaw.user === botId)) };
  } catch (err) {
    log.warn("triage history unavailable", { channel: ev.channel, error: (err as Error).message });
    return { history: [], lastSpeakerId: null, lastWasBot: false };
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
  const [proactive, feats] = await Promise.all([channelIsProactive(ev.channel), channelFeatures(ev.channel)]);
  if (!proactive && !feats.nudge) return "quiet";
  // free heuristics first: most chatter never reaches a model
  const pre = triagePrefilter({ text: ev.text ?? "", botUserId: o.botUserId, context: o.context });
  if (!pre.pass) return "filtered";
  const [speaker] = ev.user ? await db.select({ name: users.name }).from(users).where(eq(users.id, ev.user)) : [];
  const { history, lastSpeakerId, lastWasBot } = await loadHistory(ev, o.context, o.botUserId);
  if (!triagePrefilter({ text: ev.text ?? "", botUserId: o.botUserId, context: o.context, lastSpeakerId, speakerId: ev.user, lastWasBot }).pass) return "filtered";
  if (!sampleTriage(ev.channel, ev.ts).sampled) return "sampled";
  const rate = await checkRate({ userId: ev.user ?? "unknown", channelId: ev.channel, kind: "triage" });
  if (!rate.ok) return "rate_limited";
  const text = stripMention(ev.text ?? "", o.botUserId);
  // memory first, restricted to what THIS channel may read: feeds the nudge, the triage prompt and the auto-reply gate
  const hits = await consultMemory({ channelId: ev.channel, isPrivate: o.isPrivate, text });
  const decision = feats.nudge && ev.user ? strongDecision(hits) : undefined;
  if (decision && await sendEphemeral({ channelId: ev.channel, userId: ev.user!, threadTs: ev.thread_ts ?? ev.ts, text: nudgeText(decision) })) return "nudged";
  if (!proactive) return "pass";
  const t = await triageDetailed({
    text, context: o.context, speaker: speaker?.name ?? ev.user,
    channelName: o.channelName, history, memory: hits.slice(0, 3).map((h) => h.text),
  });
  log.info("triage", { channel: ev.channel, decision: t.decision, source: t.source });

  if (t.decision === "PASS") return "pass";
  if (t.decision === "ACK") {
    await addReaction(ev.channel, ev.ts, t.emoji ?? "eyes");
    return "ack";
  }
  const threadTs = ev.thread_ts ?? ev.ts;
  // confidence gate (opt-in): a public answer needs a close memory match or an explicit summons; otherwise only suggest, privately
  if (feats.autoreply && t.decision === "ANSWER" && t.priority !== "summons" && bestSimilarity(hits) < AUTOREPLY_MIN_SIMILARITY) {
    if (ev.user && await sendEphemeral({ channelId: ev.channel, userId: ev.user, threadTs, text: SUGGESTION_TEXT })) return "suggested";
    return "budget";
  }
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
