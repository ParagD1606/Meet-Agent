import { and, asc, count, eq, inArray, like, lte } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { followUps, settings, users } from "../db/schema";
import { checkRate } from "../limits/rate";
import { log } from "../log";
import { hasSecret } from "../memory/ambient";
import { followUpConfirmCard } from "../slack/cards";
import { openDm, postMessage, slackClient } from "../slack/client";
import { sanitizeForSlack } from "../slack/sanitize";
import { getSetting, putSetting } from "./commitments";
import { heldByQuietHours, inWorkingHours, quietHoursOn, workingHours } from "./chase";
import { taskListMessage, openTasksFor } from "./tasks";

/**
 * DM automations. A follow-up is a one-shot or every-N-days DM:
 *  - to the requester ("remind me Friday to check with Dana"): no approval card, it only ever DMs the person who asked;
 *  - to someone else ("follow up with @Bob on the invoice"): created `proposed`, a consent card shows the requester the exact text,
 *    and Bob is only DMed after the requester clicks (`brain_fu_yes`), like ask_teammate.
 * Delivery is a minute tick (pg-boss `manager-followups`): inside working hours only (workspace timezone), charged to the
 * recipient's `followup` bucket (5 burst, 20/day). Content is only the text the requester wrote: never channel or task content.
 */
export const FOLLOWUP_CAP = 20;
export const MIN_DELAY_MS = 30_000;
const DAY = 86_400_000;
const MAX_AHEAD_MS = 366 * DAY;

export type FollowUp = typeof followUps.$inferSelect;
export class FollowUpError extends Error {}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export async function createFollowUp(a: {
  ownerId: string; targetId?: string | null; text: string; at: Date | string; repeatDays?: number | null;
  origin?: { channelId: string; threadTs?: string };
}, now = new Date()): Promise<FollowUp> {
  const text = clean(a.text).slice(0, 500);
  if (text.length < 3) throw new FollowUpError("Say what the follow-up is about.");
  if (hasSecret(text)) throw new FollowUpError("That looks like it contains a secret; I won't store or send it.");
  const at = a.at instanceof Date ? a.at : new Date(a.at);
  if (Number.isNaN(at.getTime())) throw new FollowUpError("That time is not valid; give an ISO date and time.");
  if (at.getTime() < now.getTime() + MIN_DELAY_MS) throw new FollowUpError("The time must be at least 30 seconds in the future.");
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) throw new FollowUpError("I can only schedule up to a year ahead.");
  const repeat = a.repeatDays ?? null;
  if (repeat !== null && (!Number.isInteger(repeat) || repeat < 1 || repeat > 90)) throw new FollowUpError("Repeat every 1 to 90 days.");
  const targetId = a.targetId && a.targetId !== a.ownerId ? a.targetId : null;
  if (targetId) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, targetId), eq(users.isBot, false), eq(users.deactivated, false)));
    if (!u) throw new FollowUpError("I can't message that person.");
  }
  const [{ n }] = await db.select({ n: count() }).from(followUps).where(and(eq(followUps.ownerId, a.ownerId), inArray(followUps.status, ["proposed", "pending"])));
  if (n >= FOLLOWUP_CAP) throw new FollowUpError(`You already have ${FOLLOWUP_CAP} active follow-ups; cancel one first (/brain-followups).`);
  const [row] = await db.insert(followUps).values({
    id: newId("fu_"), ownerId: a.ownerId, targetId, text, dueAt: at, repeatDays: repeat, status: targetId ? "proposed" : "pending",
    originChannelId: a.origin?.channelId ?? null, originThreadTs: a.origin?.threadTs ?? null,
  }).returning();
  return row!;
}

/** Posts the consent card for a follow-up aimed at someone else. Nothing is sent to them before the click. */
export async function proposeFollowUp(f: FollowUp): Promise<void> {
  if (!f.originChannelId || !f.targetId) return;
  const card = followUpConfirmCard({ id: f.id, target: f.targetId, text: f.text, at: f.dueAt, repeatDays: f.repeatDays });
  await postMessage({ channel: f.originChannelId, thread_ts: f.originThreadTs ?? undefined, text: card.text, blocks: card.blocks });
}

type Payload = { user?: { id?: string }; channel?: { id?: string }; container?: { channel_id?: string; message_ts?: string }; message?: { ts?: string } };

/** brain_fu_yes / brain_fu_no: only the requester's click counts. */
export async function handleFollowUpAction(payload: Payload, a: { action_id?: string; value?: string }): Promise<boolean> {
  if (a.action_id !== "brain_fu_yes" && a.action_id !== "brain_fu_no") return false;
  const yes = a.action_id === "brain_fu_yes";
  if (!a.value || !payload.user?.id) return true;
  const [row] = await db.update(followUps).set({ status: yes ? "pending" : "cancelled" })
    .where(and(eq(followUps.id, a.value), eq(followUps.status, "proposed"), eq(followUps.ownerId, payload.user.id))).returning();
  if (!row) return true;
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  if (channel && ts) {
    const text = yes ? `Scheduled. I'll follow up with <@${row.targetId}> on ${row.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC (working hours only).` : "No problem, I won't message them.";
    await (await slackClient()).chat.update({ channel, ts, text, blocks: [] }).catch(() => undefined);
  }
  return true;
}

export const listFollowUps = (ownerId: string) =>
  db.select().from(followUps).where(and(eq(followUps.ownerId, ownerId), inArray(followUps.status, ["proposed", "pending"]))).orderBy(asc(followUps.dueAt)).limit(50);

/** Owner cancels one of their own follow-ups. */
export async function cancelFollowUp(id: string, ownerId: string): Promise<boolean> {
  const r = await db.update(followUps).set({ status: "cancelled" })
    .where(and(eq(followUps.id, id), eq(followUps.ownerId, ownerId), inArray(followUps.status, ["proposed", "pending"]))).returning({ id: followUps.id });
  return r.length > 0;
}

async function dm(userId: string, text: string, blocks?: unknown[]): Promise<void> {
  const channel = await openDm(userId);
  if (!channel) throw new Error("could not open DM");
  await postMessage({ channel, text: sanitizeForSlack(text), blocks });
}

/** Sends every due follow-up (working hours only, recipient cap). Returns how many were delivered. */
export async function followUpTick(now = new Date()): Promise<number> {
  if (await heldByQuietHours(now)) return 0;
  const due = await db.select().from(followUps).where(and(eq(followUps.status, "pending"), lte(followUps.dueAt, now))).orderBy(asc(followUps.dueAt)).limit(100);
  let sent = 0;
  for (const f of due) {
    const to = f.targetId ?? f.ownerId;
    if (!(await checkRate({ userId: to, channelId: "dm", kind: "followup" }, now.getTime())).ok) continue;
    let next = f.dueAt;
    if (f.repeatDays) { const step = f.repeatDays * DAY; next = new Date(f.dueAt.getTime() + Math.ceil((now.getTime() - f.dueAt.getTime() + 1) / step) * step); }
    // claim first (status + due unchanged) so two workers never double-send
    const claimed = await db.update(followUps).set({ status: f.repeatDays ? "pending" : "sent", dueAt: next, sendCount: f.sendCount + 1, lastSentAt: now })
      .where(and(eq(followUps.id, f.id), eq(followUps.status, "pending"), eq(followUps.dueAt, f.dueAt))).returning({ id: followUps.id });
    if (!claimed.length) continue;
    try {
      await dm(to, f.targetId ? `Hi, <@${f.ownerId}> asked me to follow up with you: "${f.text}". Only that text was shared.` : `:alarm_clock: Reminder: ${f.text}`);
      sent++;
    } catch (e) {
      await db.update(followUps).set({ status: "failed" }).where(eq(followUps.id, f.id));
      log.warn("follow-up DM failed", { id: f.id, err: String(e) });
    }
  }
  return sent;
}

// ---------- per-user preferences: daily task digest, weekly follow-up summary (settings `followprefs:<user>`) ----------
export type Prefs = { digest?: { on: boolean; time: string; days: number[] }; weekly?: { on: boolean }; lastDigest?: string; lastWeekly?: string };
const pkey = (u: string) => `followprefs:${u}`;
export const getPrefs = async (u: string): Promise<Prefs> => (await getSetting<Prefs>(pkey(u))) ?? {};
export const setPrefs = async (u: string, patch: Partial<Prefs>) => putSetting(pkey(u), { ...(await getPrefs(u)), ...patch });

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** "mon-fri", "mon,wed,fri", "weekdays", "daily" -> ISO weekdays (1 = Monday). Empty/unknown -> weekdays. */
export function parseDays(s: string): number[] {
  const t = s.toLowerCase().trim();
  if (!t || t === "weekdays") return [1, 2, 3, 4, 5];
  if (t === "daily" || t === "everyday") return [1, 2, 3, 4, 5, 6, 7];
  const out = new Set<number>();
  for (const part of t.split(",")) {
    const [a, b] = part.split("-").map((x) => DAYS.indexOf(x.trim().slice(0, 3)) + 1);
    if (!a) continue;
    if (b && b >= a) for (let d = a; d <= b; d++) out.add(d); else out.add(a);
  }
  return out.size ? [...out].sort() : [1, 2, 3, 4, 5];
}

export function localParts(now: Date, tz: string): { date: string; wd: number; hhmm: string } {
  const parts = (z: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  let p;
  try { p = parts(tz); } catch { p = parts("UTC"); }
  return { date: `${p.year}-${p.month}-${p.day}`, wd: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) + 1, hhmm: `${p.hour}:${p.minute}` };
}

async function sendCapped(userId: string, now: Date, text: string, blocks?: unknown[]): Promise<boolean> {
  if (!(await checkRate({ userId, channelId: "dm", kind: "followup" }, now.getTime())).ok) return false;
  try { await dm(userId, text, blocks); return true; } catch (e) { log.warn("digest DM failed", { userId, err: String(e) }); return false; }
}

/** Daily task digest (default off) and Friday 16:00 follow-up summary (default off), per person, workspace timezone, working hours only. */
export async function digestTick(now = new Date()): Promise<{ digests: number; weekly: number }> {
  const out = { digests: 0, weekly: 0 };
  const h = await workingHours();
  if (quietHoursOn() && !inWorkingHours(now, h)) return out;
  const lp = localParts(now, h.tz);
  const rows = await db.select().from(settings).where(like(settings.key, "followprefs:%"));
  for (const r of rows) {
    const userId = r.key.slice("followprefs:".length);
    const p = r.value as Prefs;
    if (p.digest?.on && p.digest.days.includes(lp.wd) && lp.hhmm >= p.digest.time && p.lastDigest !== lp.date) {
      await setPrefs(userId, { lastDigest: lp.date }); // once per local day, even when there is nothing to say
      const m = await taskListMessage(userId, { heading: ":sunrise: Your task digest" });
      if (m.count && (await sendCapped(userId, now, m.text, m.blocks))) out.digests++;
    }
    if (p.weekly?.on && lp.wd === 5 && lp.hhmm >= "16:00" && p.lastWeekly !== lp.date) {
      await setPrefs(userId, { lastWeekly: lp.date });
      const mine = await listFollowUps(userId);
      const { assigned, mine: owned } = await openTasksFor(userId);
      if (mine.length + assigned.length + owned.length) {
        const lines = [
          `:memo: *Your week ahead*`,
          mine.length ? `*Follow-ups scheduled* (${mine.length})\n${mine.slice(0, 8).map((f) => `• ${f.text} (${f.dueAt.toISOString().slice(0, 10)}${f.targetId ? `, with <@${f.targetId}>` : ""})`).join("\n")}` : "",
          owned.length ? `*Open tasks assigned to you:* ${owned.length}${owned.filter((c) => c.status === "overdue").length ? ` (${owned.filter((c) => c.status === "overdue").length} overdue)` : ""}` : "",
          owned.filter((c) => !c.dueAt).length ? `*No due date:* ${owned.filter((c) => !c.dueAt).length} (set one in the Tasks tab)` : "",
          assigned.length ? `*Waiting on others:* ${assigned.length} task${assigned.length === 1 ? "" : "s"} you assigned still open${assigned.filter((c) => !c.ownerId).length ? ` (${assigned.filter((c) => !c.ownerId).length} with no owner)` : ""}` : "",
          "_Use /brain-tasks to see and close them._",
        ].filter(Boolean).join("\n");
        if (await sendCapped(userId, now, lines)) out.weekly++;
      }
    }
  }
  return out;
}
