import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { channels, commitments, users } from "../db/schema";
import { log } from "../log";
import { ambientIo, hasSecret, textHash } from "../memory/ambient";
import { scanMemoryText } from "../memory/core-blocks";
import { addFact } from "../memory/facts";
import { completeJson } from "../memory/llm";
import { syncTaskFact } from "./task-sync";
import { ACTIVE, channelScope, COMMIT_CUE, extractFromText, resolveCommitment, resolveOwner, type Commitment } from "./commitments";

/**
 * Real-time task capture: every message in a channel the bot is in is cue-checked (no model call unless it sounds like a task),
 * then run through the commitments extractor with the author, message timestamp and an exact permalink. Idempotent by
 * (channel, message ts) through commitments.source_ref = msg:<channel>:<ts>:<i>.
 */
const MENTION = /<@[UW][A-Z0-9]{3,}/;
const ASK_CUE = /\b(please|pls|plz|can you|could you|would you|need(s)? to|should|take|handle|own|owns|assign(ed)?|todo|on it|i'?ll|i will)\b/i;
export const hasTaskCue = (raw: string): boolean => COMMIT_CUE.test(raw) || (MENTION.test(raw) && ASK_CUE.test(raw));

export type TaskEv = { channel: string; ts: string; thread_ts?: string; user: string; text: string };

const fallbackLink = (channel: string, ts: string) => `https://slack.com/app_redirect?channel=${channel}&message_ts=${ts}`;

/** Extracts and stores the commitments in one channel message. Returns how many were created. Never throws. */
export async function captureTaskMessage(ev: TaskEv, o: { noChase?: boolean } = {}): Promise<number> {
  try {
    if (!ev.text || !hasTaskCue(ev.text) || hasSecret(ev.text) || scanMemoryText(ev.text)) return 0;
    const [ch] = await db.select().from(channels).where(eq(channels.id, ev.channel));
    if (!ch || ch.isIm || !ch.botIsMember || ch.observe === false || ch.proactivity === "quiet") return 0;
    const n = await extractFromText(ev.text, {
      sourceRef: `msg:${ev.channel}:${ev.ts}`, sourceType: "message", scopeTag: await channelScope(ev.channel), channelId: ev.channel,
      threadTs: ev.thread_ts ?? ev.ts, now: new Date(Number(ev.ts) * 1000), author: ev.user, sourceTs: ev.ts, sourceHash: textHash(ev.text),
      noChase: o.noChase, anyCue: true,
    });
    if (n) {
      const link = (await ambientIo.permalink(ev.channel, ev.ts).catch(() => null)) ?? fallbackLink(ev.channel, ev.ts);
      await db.update(commitments).set({ permalink: link }).where(and(eq(commitments.channelId, ev.channel), eq(commitments.sourceTs, ev.ts), isNull(commitments.permalink)));
    }
    return n;
  } catch (e) {
    log.warn("task capture failed", { channel: ev.channel, err: String(e).slice(0, 200) });
    return 0;
  }
}

// ---------- thread replies: "I'll take this", "Dana took this instead", "done" ----------
const STATUS_CUE = /\b(done|shipped|finished|completed|merged|deployed|sent (it|them)|handled|resolved|took|take|taking|got (this|it)|i'?ll|i will|on it|reassign\w*|instead|hand(ing)? (it )?(off|over)|cancel+ed|dropped|no longer|not doing)\b/i;
const verdict = z.object({ action: z.enum(["done", "reassign", "none"]), index: z.number().int().min(0).max(9).optional(), owner: z.string().nullable().optional() });
const CLASSIFY = `You read ONE reply in a thread that contains tracked tasks and decide whether it changes a task's status.
"done": the replier (or someone) says the task is finished/shipped/completed. "reassign": someone takes the task or says it moved to another person ("I'll take this" -> the replier; "Dana took this instead" -> Dana). "none": anything else (questions, discussion, progress updates).
"index" is the 0-based index of the affected task in the list. "owner" (reassign only) is the new owner's Slack id (<@U1> or U1) when shown, else the name as written; for "I'll take this" use the replier's id.
Return JSON only: {"action":"none"} or {"action":"done","index":0} or {"action":"reassign","index":0,"owner":"<@U1>"}.`;

const nameOf = async (id: string | null) => (id ? (await db.select({ n: users.name }).from(users).where(eq(users.id, id)))[0]?.n ?? "a teammate" : "someone");

/** Applies a thread reply to the commitments of that thread. Returns the action taken ("none" when nothing changed). */
export async function applyThreadReply(ev: TaskEv): Promise<"done" | "reassign" | "none"> {
  try {
    if (!ev.thread_ts || ev.thread_ts === ev.ts || !ev.text || !STATUS_CUE.test(ev.text)) return "none";
    const rows = await db.select().from(commitments).where(and(eq(commitments.channelId, ev.channel), eq(commitments.threadTs, ev.thread_ts), inArray(commitments.status, [...ACTIVE]))).limit(10);
    if (!rows.length) return "none";
    const list = rows.map((r, i) => `${i}: ${r.ownerName ?? r.ownerId ?? "unowned"} - ${r.text}`).join("\n");
    const v = await completeJson({ system: CLASSIFY, prompt: `Tasks:\n${list}\n\nReplier: <@${ev.user}>\nReply: ${ev.text.slice(0, 1000)}`, role: "extract", maxOutputTokens: 120 }, verdict);
    const row = rows[v.index ?? 0];
    if (v.action === "none" || !row) return "none";
    if (v.action === "done") {
      if (!(await resolveCommitment(row.id, "done", { id: ev.user }))) return "none"; // only the owner or assigner closes
      await statusFact(row, `"${row.text}" was marked done by ${await nameOf(ev.user)}`, ev);
      return "done";
    }
    const owner = await resolveOwner(v.owner ?? `<@${ev.user}>`, ev.channel);
    if (!owner.id || owner.id === row.ownerId) return "none";
    const [after] = await db.update(commitments).set({ ownerId: owner.id, ownerName: owner.name, nudgeCount: 0, lastNudgedAt: null }).where(and(eq(commitments.id, row.id), inArray(commitments.status, [...ACTIVE]))).returning();
    if (!after) return "none";
    await syncTaskFact(after);
    await statusFact(row, `${owner.name ?? "A teammate"} took over "${row.text}" from ${row.ownerName ?? "the previous owner"}`, ev);
    return "reassign";
  } catch (e) {
    log.warn("thread reply task update failed", { channel: ev.channel, err: String(e).slice(0, 200) });
    return "none";
  }
}

/** Status changes are also facts, so memory search and "what happened to X" see them. Same scope as the commitment. */
async function statusFact(row: Commitment, text: string, ev: TaskEv): Promise<void> {
  if (scanMemoryText(text)) return;
  await addFact({
    tag: row.scopeTag, text, source: "slack", sourceRef: `${ev.channel}/${ev.ts}`, createdBy: ev.user,
    permalink: row.permalink, factType: "fact", confidence: 0.8, agentContext: "primary",
  }).catch((e) => log.warn("task status fact failed", { err: String(e).slice(0, 200) }));
}

// ---------- edits and deletes ----------
/** message_deleted: retire (dropped) every still-active commitment that came from this message. */
export async function retireTaskMessage(channel: string, ts: string): Promise<number> {
  const r = await db.update(commitments).set({ status: "dropped", completedAt: new Date() })
    .where(and(eq(commitments.channelId, channel), eq(commitments.sourceTs, ts), inArray(commitments.status, [...ACTIVE]))).returning();
  for (const row of r) await syncTaskFact(row); // memory follows the tab
  return r.length;
}

/** message_changed: when the text really changed, drop the still-active commitments from the old text and re-extract from the new one. */
export async function refreshTaskMessage(ev: TaskEv): Promise<number> {
  const rows = await db.select().from(commitments).where(and(eq(commitments.channelId, ev.channel), eq(commitments.sourceTs, ev.ts)));
  const h = textHash(ev.text);
  if (rows.length && rows.every((r) => r.sourceHash === h)) return 0;
  if (rows.length) await db.delete(commitments).where(and(eq(commitments.channelId, ev.channel), eq(commitments.sourceTs, ev.ts), inArray(commitments.status, [...ACTIVE])));
  return captureTaskMessage(ev);
}
