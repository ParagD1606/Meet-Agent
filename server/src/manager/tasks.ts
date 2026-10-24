import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { commitments } from "../db/schema";
import { db } from "../db";
import { log } from "../log";
import { readTags } from "../memory/scope";
import { button, section } from "../slack/cards";
import { sanitizeForSlack } from "../slack/sanitize";
import { ACTIVE, canRead, listCommitments, type Commitment } from "./commitments";

// ---------- exception flags (computed, never stored) ----------
export type TaskFlag = "overdue" | "unassigned" | "noDue" | "dueSoon" | "stale" | "urgent";
const DAY = 86_400_000;
export const DUE_SOON_DAYS = 3;
export const STALE_DAYS = 14;
type Flaggable = Pick<Commitment, "status" | "ownerId" | "dueAt" | "priority" | "createdAt" | "lastNudgedAt">;

/** Pure. Flags only apply to active tasks. stale = still `open` (never started) for > 14 days and not nudged in that time (there is no updated_at column). */
export function taskFlags(c: Flaggable, now = new Date()): TaskFlag[] {
  if (!ACTIVE.includes(c.status as never)) return [];
  const t = now.getTime(), due = c.dueAt?.getTime();
  const out: TaskFlag[] = [];
  if (due !== undefined && due <= t) out.push("overdue");
  if (!c.ownerId) out.push("unassigned");
  if (due === undefined) out.push("noDue");
  if (due !== undefined && due > t && due <= t + DUE_SOON_DAYS * DAY) out.push("dueSoon");
  if (c.status === "open" && t - c.createdAt.getTime() > STALE_DAYS * DAY && (!c.lastNudgedAt || t - c.lastNudgedAt.getTime() > STALE_DAYS * DAY)) out.push("stale");
  if (c.priority === "urgent") out.push("urgent");
  return out;
}

/** The same flags as SQL conditions (kept in step with taskFlags; tests compare the two). */
export function flagSql(now = new Date()) {
  const act = inArray(commitments.status, [...ACTIVE]);
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  return {
    active: act,
    overdue: and(act, lte(commitments.dueAt, now))!,
    unassigned: and(act, isNull(commitments.ownerId))!,
    noDue: and(act, isNull(commitments.dueAt))!,
    dueSoon: and(act, gt(commitments.dueAt, now), lte(commitments.dueAt, new Date(now.getTime() + DUE_SOON_DAYS * DAY)))!,
    stale: and(act, eq(commitments.status, "open"), lt(commitments.createdAt, ago(STALE_DAYS)), or(isNull(commitments.lastNudgedAt), lt(commitments.lastNudgedAt, ago(STALE_DAYS))))!,
    urgent: and(act, eq(commitments.priority, "urgent"))!,
    done7d: and(eq(commitments.status, "done"), gte(commitments.completedAt, ago(7)))!,
  };
}

export type TaskCounts = { total: number; open: number; overdue: number; unassigned: number; noDue: number; dueSoon: number; done7d: number };
/** Counts over exactly the rows `scope` allows (the caller's visibility condition): unreadable tasks are never counted. */
export async function taskCounts(scope: ReturnType<typeof and>, now = new Date()): Promise<TaskCounts> {
  const f = flagSql(now);
  const n = (c: unknown) => sql<number>`count(*) filter (where ${c})::int`;
  const [r] = await db.select({ total: sql<number>`count(*)::int`, open: n(f.active), overdue: n(f.overdue), unassigned: n(f.unassigned), noDue: n(f.noDue), dueSoon: n(f.dueSoon), done7d: n(f.done7d) })
    .from(commitments).where(scope);
  return r!;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no due date");
const MAX_ROWS = 8;

/** Open tasks for one person: what they own and what they assigned to others. Scope-filtered to what THEY can read. */
export async function openTasksFor(userId: string): Promise<{ mine: Commitment[]; assigned: Commitment[] }> {
  const tags = await readTags({ channelId: "", isPrivate: false, isIm: true, userId });
  const keep = async (rows: Commitment[]) => { const out: Commitment[] = []; for (const r of rows) if (await canRead(r, userId)) out.push(r); return out; };
  const mine = await keep(await listCommitments({ tags, status: [...ACTIVE], ownerId: userId, limit: 50 }));
  const assigned = (await keep(await listCommitments({ tags, status: [...ACTIVE], assignerId: userId, limit: 50 }))).filter((r) => r.ownerId !== userId);
  return { mine, assigned };
}

const line = (c: Commitment, viewer: string) =>
  sanitizeForSlack(`${c.priority === "urgent" ? ":rotating_light: *URGENT* " : ""}${c.status === "overdue" ? ":warning: " : ""}${c.status === "in_progress" ? "[in progress] " : ""}${c.text} (due ${day(c.dueAt)})${c.ownerId === viewer ? "" : c.ownerId ? ` - <@${c.ownerId}>` : " - _no owner_"}${c.permalink ? ` - <${c.permalink}|source>` : ""}`);

function rows(title: string, list: Commitment[], viewer: string, buttons: boolean): unknown[] {
  if (!list.length) return [];
  const shown = list.slice(0, MAX_ROWS);
  return [
    section(`*${title}* (${list.length})`),
    ...shown.flatMap((c) => [
      section(line(c, viewer)),
      ...(buttons ? [{ type: "actions", elements: [button("Done", "brain_task_done", { value: c.id, style: "primary" }), button("Drop", "brain_task_drop", { value: c.id })] }] : []),
    ]),
    ...(list.length > shown.length ? [section(`_...and ${list.length - shown.length} more._`)] : []),
  ];
}

/** Message body for /brain-tasks and the daily digest. Exception sections come first (a task appears once, in the first section it fits); `buttons` adds Done/Drop per task. */
export async function taskListMessage(userId: string, o: { buttons?: boolean; heading?: string; now?: Date } = {}): Promise<{ text: string; blocks: unknown[]; count: number; stats: { overdue: number; unassigned: number; noDue: number; dueSoon: number; waiting: number } }> {
  const now = o.now ?? new Date();
  const { mine, assigned } = await openTasksFor(userId);
  const buttons = o.buttons ?? true;
  const all = [...mine, ...assigned];
  const fl = new Map(all.map((c) => [c.id, taskFlags(c, now)]));
  const has = (c: Commitment, f: TaskFlag) => fl.get(c.id)!.includes(f);
  const shown = new Set<string>();
  const take = (f: TaskFlag) => { const l = all.filter((c) => !shown.has(c.id) && has(c, f)); l.forEach((c) => shown.add(c.id)); return l; };
  const overdue = take("overdue"), unassigned = take("unassigned"), noDue = take("noDue"), dueSoon = take("dueSoon");
  const rest = (l: Commitment[]) => l.filter((c) => !shown.has(c.id));
  const stats = { overdue: all.filter((c) => has(c, "overdue")).length, unassigned: all.filter((c) => has(c, "unassigned")).length, noDue: all.filter((c) => has(c, "noDue")).length, dueSoon: all.filter((c) => has(c, "dueSoon")).length, waiting: assigned.length };
  const blocks = [
    ...rows("Overdue", overdue, userId, buttons), ...rows("Unassigned (you assigned, no owner)", unassigned, userId, buttons),
    ...rows("No due date", noDue, userId, buttons), ...rows("Due soon", dueSoon, userId, buttons),
    ...rows("Assigned to you", rest(mine), userId, buttons), ...rows("You assigned", rest(assigned), userId, buttons),
  ];
  const count = mine.length + assigned.length;
  if (!count) return { text: "You have no open tasks.", blocks: [section(o.heading ? `${o.heading}\n_No open tasks._` : "_You have no open tasks._")], count, stats };
  const summary = section(`*Overdue (${stats.overdue})* | *No due date (${stats.noDue})* | *Waiting on others (${stats.waiting})*`);
  return { text: `${o.heading ?? "Your tasks"}: ${mine.length} assigned to you, ${assigned.length} you assigned.`, blocks: [...(o.heading ? [section(o.heading)] : []), summary, ...blocks], count, stats };
}

/** Replaces the message a task button was clicked in (response_url), with the refreshed list. */
export async function refreshTaskList(responseUrl: string | undefined, userId: string): Promise<void> {
  if (!responseUrl) return;
  const m = await taskListMessage(userId);
  try {
    await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text: m.text, blocks: m.blocks }) });
  } catch (e) { log.warn("task list refresh failed", { error: (e as Error).message }); }
}
