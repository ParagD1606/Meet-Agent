import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, commitments, users } from "../db/schema";
import { checkRate } from "../limits";
import { log } from "../log";
import { slackClient } from "../slack/client";
import { sanitizeForSlack } from "../slack/sanitize";
import { refreshTaskList } from "./tasks";
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

// ---------- quiet hours ----------
export type Hours = { tz: string; start: number; end: number };
/** Workspace timezone from settings.timezone (IANA), working window from settings.manager_hours; default UTC 9-18 Mon-Fri. */
export async function workingHours(): Promise<Hours> {
  const tz = await getSetting<string>("timezone");
  const h = await getSetting<{ start?: number; end?: number }>("manager_hours");
  return { tz: typeof tz === "string" && tz ? tz : "UTC", start: h?.start ?? 9, end: h?.end ?? 18 };
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
async function sendNudge(c: Commitment, now: Date): Promise<void> {
  const slack = await slackClient();
  const overdue = !!c.dueAt && c.dueAt <= now;
  const src = c.permalink ? ` (<${c.permalink}|source>)` : "";
  const body = `${overdue ? ":warning: Overdue" : ":alarm_clock: Due soon"}${c.dueAt ? ` (${day(c.dueAt)})` : ""}: ${c.text}${src}\nIs this done?`;
  let inThread = false;
  if (c.channelId && c.threadTs) {
    const [m] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, c.channelId), eq(channelMembers.userId, c.ownerId!)));
    inThread = !!m;
  }
  if (inThread) {
    const text = sanitizeForSlack(`<@${c.ownerId}> ${body}`);
    await slack.chat.postMessage({ channel: c.channelId!, thread_ts: c.threadTs!, text, blocks: nudgeBlocks(c, text) });
    return;
  }
  const dm = await slack.conversations.open({ users: c.ownerId! });
  const channel = dm.channel?.id;
  if (!channel) throw new Error("could not open DM");
  const text = sanitizeForSlack(body);
  await slack.chat.postMessage({ channel, text, blocks: nudgeBlocks(c, text) });
}

const ownerCanRead = (c: Commitment) => canRead(c, c.ownerId!);

/** Marks overdue, then nudges every owner whose commitment is due for it. Respects quiet hours and the per-person chase bucket. */
export async function chaseTick(now = new Date()): Promise<number> {
  await markOverdue(now);
  if (!inWorkingHours(now, await workingHours())) return 0;
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
  if (list) { await refreshTaskList(payload.response_url, uid); return true; }
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  if (row && channel && ts) {
    const text = status === "done" ? `:white_check_mark: Marked done: ${row.text}` : `Dropped: ${row.text}`;
    await (await slackClient()).chat.update({ channel, ts, text: sanitizeForSlack(text), blocks: [] }).catch((e: Error) => log.warn("commitment ack failed", { error: e.message }));
  }
  return true;
}
