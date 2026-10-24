import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { tuningEnv } from "../config";
import { db } from "../db";
import { channelMembers, commitments, users } from "../db/schema";
import { checkRate } from "../limits";
import { log } from "../log";
import { slackClient } from "../slack/client";
import { sanitizeForSlack } from "../slack/sanitize";
import { refreshTaskList } from "./tasks";
import { notifyAssignerDone } from "./task-sync";
import { ACTIVE, canRead, getSetting, markOverdue, resolveCommitment, type Commitment } from "./commitments";

const DAY = 86_400_000;
export const MAX_NUDGES = 3;

// ---------- timing ----------
/** Pure. Nudge when due within 24h or overdue and never nudged; once more at the first overdue tick; then at most daily, MAX_NUDGES total. */
export function shouldNudge(c: Pick<Commitment, "status" | "ownerId" | "dueAt" | "lastNudgedAt" | "nudgeCount">, now: Date): boolean {
  if (!c.ownerId || !c.dueAt || !ACTIVE.includes(c.status as never) || c.nudgeCount >= MAX_NUDGES) return false;
  if (c.dueAt.getTime() - now.getTime() > DAY) return false;
  if (!c.lastNudgedAt) return true;
  const overdue = c.dueAt <= now;
  if (!overdue) return false;
  return c.lastNudgedAt < c.dueAt || now.getTime() - c.lastNudgedAt.getTime() >= DAY;
}

/** Pure. No due date: chase weekly (max 3) the owner, only when urgent or older than 14 days. Reuses last_nudged_at / nudge_count (a task without a date is never due-nudged). */
export function shouldChaseNoDue(c: Pick<Commitment, "status" | "ownerId" | "dueAt" | "priority" | "createdAt" | "lastNudgedAt" | "nudgeCount">, now: Date): boolean {
  if (!c.ownerId || c.dueAt || !ACTIVE.includes(c.status as never) || c.nudgeCount >= MAX_NUDGES) return false;
  if (c.priority !== "urgent" && now.getTime() - c.createdAt.getTime() <= 14 * DAY) return false;
  return !c.lastNudgedAt || now.getTime() - c.lastNudgedAt.getTime() >= 7 * DAY;
}
/** Pure. No owner: tell the assigner (only) every 3 days, max 3. */
export function shouldSurfaceUnassigned(c: Pick<Commitment, "status" | "ownerId" | "assignerId" | "lastNudgedAt" | "nudgeCount">, now: Date): boolean {
  if (c.ownerId || !c.assignerId || !ACTIVE.includes(c.status as never) || c.nudgeCount >= MAX_NUDGES) return false;
  return !c.lastNudgedAt || now.getTime() - c.lastNudgedAt.getTime() >= 3 * DAY;
}

// ---------- quiet hours ----------
/**
 * Quiet/working hours are OFF by default (Pixel messages people straight away). Turn on with the admin setting
 * (settings.quiet_hours_enabled) or force on with QUIET_HOURS=1: chases, follow-ups, digests and routed questions then wait for the working window.
 * Sync reads use a cache that every workingHours() call (and the settings PUT) refreshes.
 */
export type Hours = { tz: string; start: number; end: number };
let cached: { hours: Hours; quiet: boolean } = { hours: { tz: "UTC", start: 9, end: 18 }, quiet: false };
export const quietHoursOn = (): boolean => tuningEnv().quietHoursForced || cached.quiet;
/** Workspace timezone from settings.timezone (IANA), working window from settings.manager_hours; default UTC 9-18 Mon-Fri. */
export async function workingHours(): Promise<Hours> {
  const tz = await getSetting<string>("timezone");
  const h = await getSetting<{ start?: number; end?: number }>("manager_hours");
  const quiet = await getSetting<boolean>("quiet_hours_enabled");
  const hours = { tz: typeof tz === "string" && tz ? tz : "UTC", start: h?.start ?? 9, end: h?.end ?? 18 };
  cached = { hours, quiet: quiet === true };
  return hours;
}
/** Last window read by workingHours(); for sync callers (teammate.nextWindow). */
export const cachedHours = (): Hours => cached.hours;
/** True when quiet hours are on and `now` is outside the working window. */
export async function heldByQuietHours(now: Date): Promise<boolean> {
  const h = await workingHours();
  return quietHoursOn() && !inWorkingHours(now, h);
}

/** Pure. True inside the window, Mon-Fri; an invalid timezone falls back to UTC. */
export function inWorkingHours(now: Date, h: Hours): boolean {
  const parts = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  let p;
  try { p = parts(h.tz); } catch { p = parts("UTC"); }
  const wd = p.find((x) => x.type === "weekday")!.value;
  const hour = Number(p.find((x) => x.type === "hour")!.value);
  return wd !== "Sat" && wd !== "Sun" && hour >= h.start && hour < h.end;
}

// ---------- sending ----------
const day = (d: Date) => d.toISOString().slice(0, 10);

function nudgeBlocks(c: Commitment, text: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements: [
      { type: "button", action_id: "brain_commit_done", text: { type: "plain_text", text: "Done" }, style: "primary", value: c.id },
      { type: "button", action_id: "brain_commit_drop", text: { type: "plain_text", text: "Drop" }, value: c.id },
    ] },
  ];
}

/** Posts in the original thread with an @mention when the owner is a member of that channel, else DMs them. */
async function sendNudge(c: Commitment, now: Date, kind: "due" | "noDue" | "unassigned" = "due"): Promise<void> {
  const slack = await slackClient();
  const overdue = !!c.dueAt && c.dueAt <= now;
  const src = c.permalink ? ` (<${c.permalink}|source>)` : "";
  const body = kind === "noDue" ? `:calendar: No due date yet: ${c.text}${src}\nWhen should this be done? Set a date in the Tasks tab, or mark it done.`
    : kind === "unassigned" ? `:bust_in_silhouette: Nobody owns this task you assigned: ${c.text}${src}\nAssign it in the Tasks tab, or drop it.`
    : `${overdue ? ":warning: Overdue" : ":alarm_clock: Due soon"}${c.dueAt ? ` (${day(c.dueAt)})` : ""}: ${c.text}${src}\nIs this done?`;
  const to = kind === "unassigned" ? c.assignerId! : c.ownerId!;
  let inThread = false;
  if (kind === "due" && c.channelId && c.threadTs) {
    const [m] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, c.channelId), eq(channelMembers.userId, c.ownerId!)));
    inThread = !!m;
  }
  if (inThread) {
    const text = sanitizeForSlack(`<@${c.ownerId}> ${body}`);
    await slack.chat.postMessage({ channel: c.channelId!, thread_ts: c.threadTs!, text, blocks: nudgeBlocks(c, text) });
    return;
  }
  const dm = await slack.conversations.open({ users: to });
  const channel = dm.channel?.id;
  if (!channel) throw new Error("could not open DM");
  const text = sanitizeForSlack(body);
  await slack.chat.postMessage({ channel, text, blocks: nudgeBlocks(c, text) });
}

const ownerCanRead = (c: Commitment) => canRead(c, c.ownerId!);

/** Marks overdue, then nudges every owner whose commitment is due for it. Respects quiet hours and the per-person chase bucket. */
export async function chaseTick(now = new Date()): Promise<number> {
  await markOverdue(now);
  if (await heldByQuietHours(now)) return 0;
  const rows = await db.select().from(commitments).where(and(
    inArray(commitments.status, [...ACTIVE]), isNotNull(commitments.ownerId), lte(commitments.dueAt, new Date(now.getTime() + DAY)),
  )).limit(200);
  let sent = 0;
  for (const c of rows) {
    if (!shouldNudge(c, now) || !(await ownerCanRead(c))) continue;
    if (!(await checkRate({ userId: c.ownerId!, channelId: c.channelId ?? "dm", kind: "chase" }, now.getTime())).ok) continue;
    // claim first so two workers never double-nudge; restored when the send fails
    const claimed = await db.update(commitments).set({ lastNudgedAt: now, nudgeCount: c.nudgeCount + 1 })
      .where(and(eq(commitments.id, c.id), eq(commitments.nudgeCount, c.nudgeCount))).returning({ id: commitments.id });
    if (!claimed.length) continue;
    try { await sendNudge(c, now); sent++; }
    catch (e) {
      await db.update(commitments).set({ lastNudgedAt: c.lastNudgedAt, nudgeCount: c.nudgeCount }).where(eq(commitments.id, c.id));
      log.warn("commitment nudge failed", { id: c.id, err: String(e) });
    }
  }
  sent += await exceptionChase(now);
  return sent;
}

/** Weekly chase of dateless tasks (owner) and 3-day surfacing of ownerless tasks (assigner only). Same claim-first / rate-limit / scope rules as the due nudges. */
async function exceptionChase(now: Date): Promise<number> {
  const noDue = await db.select().from(commitments).where(and(inArray(commitments.status, [...ACTIVE]), isNotNull(commitments.ownerId), isNull(commitments.dueAt), lte(commitments.nudgeCount, MAX_NUDGES - 1))).limit(200);
  const unowned = await db.select().from(commitments).where(and(inArray(commitments.status, [...ACTIVE]), isNull(commitments.ownerId), isNotNull(commitments.assignerId), lte(commitments.nudgeCount, MAX_NUDGES - 1))).limit(200);
  let sent = 0;
  const perUser = new Map<string, number>(); // max 3 chase DMs per person per tick
  for (const [kind, list] of [["noDue", noDue], ["unassigned", unowned]] as const) {
    for (const c of list) {
      if (kind === "noDue" ? !shouldChaseNoDue(c, now) : !shouldSurfaceUnassigned(c, now)) continue;
      const to = kind === "noDue" ? c.ownerId! : c.assignerId!;
      if ((perUser.get(to + kind) ?? 0) >= 3 || !(await canRead(c, to))) continue;
      if (!(await checkRate({ userId: to, channelId: c.channelId ?? "dm", kind: "chase" }, now.getTime())).ok) continue;
      const claimed = await db.update(commitments).set({ lastNudgedAt: now, nudgeCount: c.nudgeCount + 1 })
        .where(and(eq(commitments.id, c.id), eq(commitments.nudgeCount, c.nudgeCount))).returning({ id: commitments.id });
      if (!claimed.length) continue;
      try { await sendNudge(c, now, kind); sent++; perUser.set(to + kind, (perUser.get(to + kind) ?? 0) + 1); }
      catch (e) {
        await db.update(commitments).set({ lastNudgedAt: c.lastNudgedAt, nudgeCount: c.nudgeCount }).where(eq(commitments.id, c.id));
        log.warn("exception chase failed", { id: c.id, kind, err: String(e) });
      }
    }
  }
  return sent;
}

// ---------- Done / Drop buttons ----------
type Payload = { response_url?: string; user?: { id?: string }; container?: { channel_id?: string; message_ts?: string }; channel?: { id?: string }; message?: { ts?: string } };

/** brain_commit_done / brain_commit_drop. Only the owner or an admin may close a commitment. */
export async function handleCommitmentAction(payload: Payload, a: { action_id?: string; value?: string }): Promise<boolean> {
  const list = a.action_id === "brain_task_done" || a.action_id === "brain_task_drop"; // buttons inside /brain-tasks and the digest list
  const status = a.action_id === "brain_commit_done" || a.action_id === "brain_task_done" ? "done" : a.action_id === "brain_commit_drop" || a.action_id === "brain_task_drop" ? "dropped" : null;
  if (!status) return false;
  const uid = payload.user?.id;
  if (!uid || !a.value) return true;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, uid));
  const row = await resolveCommitment(a.value, status, { id: uid, admin: u?.role === "admin" || u?.role === "owner" });
  if (row && status === "done") await notifyAssignerDone(row, uid);
  if (list) { await refreshTaskList(payload.response_url, uid); return true; }
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  if (row && channel && ts) {
    const text = status === "done" ? `:white_check_mark: Marked done: ${row.text}` : `Dropped: ${row.text}`;
    await (await slackClient()).chat.update({ channel, ts, text: sanitizeForSlack(text), blocks: [] }).catch((e: Error) => log.warn("commitment ack failed", { error: e.message }));
  }
  return true;
}
