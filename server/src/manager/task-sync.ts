import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, channels, commitments, meetings, memories, users } from "../db/schema";
import { log } from "../log";
import { scanMemoryText } from "../memory/core-blocks";
import { addFact } from "../memory/facts";
import { clearRecallCache } from "../memory/recall";
import { openDm, postMessage } from "../slack/client";
import { sanitizeForSlack } from "../slack/sanitize";
import { ACTIVE, canRead, channelOfRef, getSetting, insertCommitment, putSetting, meetingTasksToCommitments, resolveOwner, titleKey, type Commitment } from "./commitments";

/**
 * Keeps the three views of a task in agreement: the commitments row (Tasks tab, /brain-tasks, chase), the memory fact
 * ("Task X [open]: assigned to ..."), and the people involved (notifications). Every status/owner change re-writes the fact and
 * supersedes the previous one, so memory never says "open" while the tab says "done".
 */
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const userName = async (id: string | null): Promise<string | null> =>
  id ? (await db.select({ n: users.name }).from(users).where(eq(users.id, id)))[0]?.n ?? null : null;

export function taskFactText(c: Pick<Commitment, "text" | "status" | "priority" | "ownerId" | "ownerName" | "dueAt">, assignerName?: string | null): string {
  const flags = [c.status, ...(c.priority === "urgent" ? ["urgent"] : [])].join(", ");
  const owner = c.ownerId ? `${c.ownerName ?? "a teammate"} (<@${c.ownerId}>)` : c.ownerName ?? "nobody yet";
  return `Task "${c.text}" [${flags}]: assigned to ${owner}${assignerName ? ` by ${assignerName}` : ""}${c.dueAt ? `, due ${day(c.dueAt)}` : ""}.`;
}

/** Writes the task's current state as a memory fact, supersedes the previous linked fact, links commitments.memory_id. Never throws. */
export async function syncTaskFact(row: Commitment): Promise<void> {
  try {
    if (scanMemoryText(row.text)) return;
    const text = taskFactText(row, await userName(row.assignerId));
    const r = await addFact({
      tag: row.scopeTag, text, source: "slack", sourceRef: `task:${row.id}`, createdBy: row.assignerId ?? row.ownerId,
      permalink: row.permalink, factType: "fact", confidence: 0.9, agentContext: "primary",
    });
    if (row.memoryId && row.memoryId !== r.id) {
      await db.update(memories).set({ status: "superseded", supersededBy: r.id, invalidAt: new Date() }).where(and(eq(memories.id, row.memoryId), eq(memories.status, "active")));
      clearRecallCache();
    }
    if (row.memoryId !== r.id) await db.update(commitments).set({ memoryId: r.id }).where(eq(commitments.id, row.id));
  } catch (e) {
    log.warn("task fact sync failed", { id: row.id, err: String(e).slice(0, 200) });
  }
}

// ---------- messaging ----------
const buttons = (id: string) => ({ type: "actions", elements: [
  { type: "button", action_id: "brain_commit_done", text: { type: "plain_text", text: "Done" }, style: "primary", value: id },
  { type: "button", action_id: "brain_commit_drop", text: { type: "plain_text", text: "Drop" }, value: id },
] });

/** Tells the owner about a task right away (no quiet hours): @mention in the thread when they are in that channel, else a DM. */
export async function notifyTaskOwner(c: Commitment, o: { assignerId?: string | null; reassigned?: boolean } = {}): Promise<"thread" | "dm" | "none"> {
  if (!c.ownerId) return "none";
  const src = c.permalink ? ` (<${c.permalink}|source>)` : "";
  const by = o.assignerId ? `<@${o.assignerId}>` : "Someone";
  const body = `${c.priority === "urgent" ? ":rotating_light: *Urgent* " : ":pushpin: "}${by} ${o.reassigned ? "reassigned" : "assigned"} you a task: *${c.text}*${c.dueAt ? ` - due ${day(c.dueAt)}` : ""}${src}`;
  try {
    let inThread = false;
    if (c.channelId && c.threadTs) {
      const [ch] = await db.select({ im: channels.isIm }).from(channels).where(eq(channels.id, c.channelId));
      const [m] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, c.channelId), eq(channelMembers.userId, c.ownerId)));
      inThread = !!m && !ch?.im;
    }
    if (inThread) {
      const text = sanitizeForSlack(`<@${c.ownerId}> ${body}`);
      await postMessage({ channel: c.channelId!, thread_ts: c.threadTs!, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, buttons(c.id)] });
      return "thread";
    }
    const channel = await openDm(c.ownerId);
    if (!channel) return "none";
    const text = sanitizeForSlack(body);
    await postMessage({ channel, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, buttons(c.id)] });
    return "dm";
  } catch (e) {
    log.warn("task notify failed", { id: c.id, err: String(e).slice(0, 200) });
    return "none";
  }
}

/** "X completed: title" DM to whoever assigned it. */
export async function notifyAssignerDone(c: Commitment, doneBy: string | null, note?: string): Promise<boolean> {
  if (!c.assignerId || c.assignerId === doneBy) return false;
  try {
    const channel = await openDm(c.assignerId);
    if (!channel) return false;
    const who = (await userName(doneBy ?? c.ownerId)) ?? "A teammate";
    await postMessage({ channel, text: sanitizeForSlack(`:white_check_mark: ${who} completed: ${c.text}${note ? ` (${note})` : ""}${c.permalink ? ` (<${c.permalink}|source>)` : ""}`) });
    return true;
  } catch (e) {
    log.warn("assigner notify failed", { id: c.id, err: String(e).slice(0, 200) });
    return false;
  }
}

// ---------- create / change ----------
export type AssignInput = {
  title: string; ownerId: string; ownerName?: string | null; assignerId: string; dueAt?: Date | null; priority?: "normal" | "urgent";
  channelId?: string | null; threadTs?: string | null; scopeTag: string; permalink?: string | null; sourceTs?: string | null; sourceKey: string;
};

/** Creates the task (or updates the existing active one with the same owner + title + channel). */
export async function upsertTask(a: AssignInput): Promise<{ row: Commitment; created: boolean }> {
  const key = titleKey(a.title);
  const [existing] = await db.select().from(commitments).where(and(
    eq(commitments.ownerId, a.ownerId), eq(commitments.titleKey, key),
    a.channelId ? eq(commitments.channelId, a.channelId) : sql`${commitments.channelId} is null`, inArray(commitments.status, [...ACTIVE]),
  )).limit(1);
  if (existing) {
    const [row] = await db.update(commitments).set({
      ...(a.dueAt ? { dueAt: a.dueAt, nudgeCount: 0, lastNudgedAt: null } : {}), ...(a.priority ? { priority: a.priority } : {}), assignerId: a.assignerId,
    }).where(eq(commitments.id, existing.id)).returning();
    await syncTaskFact(row!);
    return { row: row!, created: false };
  }
  const row = await insertCommitment({
    ownerId: a.ownerId, ownerName: a.ownerName, text: a.title, dueAt: a.dueAt, sourceType: "message", sourceRef: `assign:${a.sourceKey}:${key}`,
    permalink: a.permalink, channelId: a.channelId, threadTs: a.threadTs, scopeTag: a.scopeTag, assignerId: a.assignerId, sourceTs: a.sourceTs, priority: a.priority,
  });
  if (row) return { row, created: true };
  const [dup] = await db.select().from(commitments).where(eq(commitments.sourceRef, `assign:${a.sourceKey}:${key}`));
  return { row: dup!, created: false }; // same message retried
}

export type TaskPatch = { status?: Commitment["status"]; ownerId?: string; due?: Date | null; priority?: "normal" | "urgent" };
export type Actor = { id: string; admin?: boolean };
export type ChangeResult = { ok: true; row: Commitment; before: Commitment } | { ok: false; error: "not_found" | "forbidden" | "bad_request"; message?: string };

/**
 * The one place task state changes (tool, API, buttons share the rules): the owner, assigner or an admin may change status/due/priority; only the
 * assigner or an admin may reassign. The asker must also be able to read the task's scope. Syncs the memory fact and notifies as needed.
 */
export async function changeTask(id: string, p: TaskPatch, by: Actor, o: { skipScope?: boolean; note?: string } = {}): Promise<ChangeResult> {
  const [before] = await db.select().from(commitments).where(eq(commitments.id, id));
  if (!before) return { ok: false, error: "not_found" };
  const involved = before.ownerId === by.id || before.assignerId === by.id;
  if (!(by.admin || involved) || (!o.skipScope && !(await canRead(before, by.id)))) return { ok: false, error: "forbidden" };
  const set: Partial<typeof commitments.$inferInsert> = {};
  if (p.ownerId !== undefined && p.ownerId !== before.ownerId) {
    if (!(by.admin || before.assignerId === by.id)) return { ok: false, error: "forbidden", message: "only the assigner or an admin can reassign" };
    const owner = await resolveOwner(p.ownerId, before.channelId);
    if (!owner.id) return { ok: false, error: "bad_request", message: "unknown person" };
    Object.assign(set, { ownerId: owner.id, ownerName: owner.name, nudgeCount: 0, lastNudgedAt: null });
  }
  if (p.status && p.status !== before.status) {
    set.status = p.status;
    set.completedAt = p.status === "done" || p.status === "dropped" ? new Date() : null;
    if (p.status === "open" || p.status === "in_progress") { set.nudgeCount = 0; set.lastNudgedAt = null; }
  }
  if (p.due !== undefined) Object.assign(set, { dueAt: p.due, nudgeCount: 0, lastNudgedAt: null });
  if (p.priority) set.priority = p.priority;
  if (!Object.keys(set).length) return { ok: true, row: before, before };
  const [row] = await db.update(commitments).set(set).where(eq(commitments.id, id)).returning();
  await syncTaskFact(row!);
  if (set.status === "done" && before.status !== "done") await notifyAssignerDone(row!, o.note ? null : by.id, o.note);
  // keep a linked GitHub issue in step (best effort); a change that came FROM GitHub (note set) must not echo back
  if (set.status && !o.note) void import("../integrations/github-reconcile").then((m) => m.githubTaskChanged(id)).catch(() => {});
  if (set.ownerId && set.ownerId !== by.id) await notifyTaskOwner(row!, { assignerId: by.id, reassigned: true });
  return { ok: true, row: row!, before };
}

// ---------- backfill ----------
const ASSIGNED = /^(?:the\s+)?(.{3,160}?)\s+task\b[^.]{0,80}?\b(?:is|was)\s+assigned\s+to\s+([^(<.]+?)\s*\(<@([UW][A-Z0-9]{3,})>\)/i;
const ASSIGNED_PLAIN = /^(?:the\s+)?(.{3,160}?)\s+(?:is|was)\s+assigned\s+to\s+([^(<.]+?)\s*\(<@([UW][A-Z0-9]{3,})>\)/i;

/** Parses "The Tales launch task ... is assigned to Parag (<@U1>)". Pure. */
export function parseAssignmentFact(text: string): { title: string; ownerName: string; ownerId: string; urgent: boolean } | null {
  const m = text.match(ASSIGNED) ?? text.match(ASSIGNED_PLAIN);
  if (!m) return null;
  const title = m[1]!.replace(/^task[:\s-]+/i, "").trim();
  if (!titleKey(title)) return null;
  return { title, ownerName: m[2]!.trim(), ownerId: m[3]!, urgent: /\burgent\b/i.test(text) };
}

/** Once per deployment (settings flag), in the background: existing assignment facts and meeting tasks become tasks. Never throws. */
export async function bootBackfillTasks(): Promise<void> {
  try {
    if (await getSetting("tasks_backfill_v1")) return;
    log.info("tasks backfill", await syncTasksFromMemory());
    await putSetting("tasks_backfill_v1", new Date().toISOString());
  } catch (e) { log.warn("tasks backfill failed", { err: String(e).slice(0, 200) }); }
}

/** One-time / on demand: active memory facts that look like assignments and meetings' tasks become commitments. Idempotent. */
export async function syncTasksFromMemory(): Promise<{ facts: number; meetings: number; scanned: number }> {
  const linked = new Set((await db.select({ m: commitments.memoryId }).from(commitments).where(isNotNull(commitments.memoryId))).map((r) => r.m));
  const rows = await db.select().from(memories).where(and(
    eq(memories.kind, "fact"), eq(memories.status, "active"), eq(memories.reviewState, "ok"), like(memories.text, "%assigned to%"),
  )).limit(2000);
  let facts = 0;
  for (const f of rows) {
    if (linked.has(f.id) || f.sourceRef?.startsWith("task:")) continue;
    const a = parseAssignmentFact(f.text);
    if (!a) continue;
    const where = f.scopeTag.startsWith("channel_") ? { channelId: f.scopeTag.slice(8), threadTs: null } : await channelOfRef(f.sourceRef);
    const owner = await resolveOwner(a.ownerId, where.channelId);
    const row = await insertCommitment({
      ownerId: owner.id ?? a.ownerId, ownerName: owner.name ?? a.ownerName, text: a.title, sourceType: "fact", sourceRef: `taskfact:${f.id}`, permalink: f.permalink,
      scopeTag: f.scopeTag, channelId: where.channelId, threadTs: where.threadTs, assignerId: f.createdBy && /^[UW][A-Z0-9]{3,}$/.test(f.createdBy) ? f.createdBy : null,
      priority: a.urgent ? "urgent" : "normal", memoryId: f.id, noChase: true,
    });
    if (row) facts++;
  }
  let m = 0;
  for (const mt of await db.select().from(meetings).where(eq(meetings.status, "ready")).limit(500)) m += await meetingTasksToCommitments(mt);
  return { facts, meetings: m, scanned: rows.length };
}
