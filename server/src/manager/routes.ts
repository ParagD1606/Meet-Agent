import { and, desc, eq, gte, ilike, inArray, like, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, commitments, users } from "../db/schema";
import { readTags } from "../memory/scope";
import { readBody } from "../routes/util";
import { ACTIVE, canRead, channelScope, listCommitments, type Commitment } from "./commitments";
import { changeTask, notifyTaskOwner, upsertTask } from "./task-sync";
import { flagSql, taskCounts, taskFlags } from "./tasks";

export const managerRoutes = new Hono<AppEnv>();

const STATUSES: Commitment["status"][] = ["open", "done", "dropped", "overdue", "in_progress"];

/** Commitments the requester may see: scope tags come from their own read surface (shared + their private channels + their DM tag), never wider. */
managerRoutes.get("/manager/commitments", requireAuth("admin"), async (c) => {
  const me = c.get("user");
  const tags = await readTags({ channelId: "", isPrivate: false, isIm: true, userId: me.id });
  const status = (c.req.query("status") ?? "").split(",").filter((s): s is Commitment["status"] => STATUSES.includes(s as never));
  const rows = await listCommitments({ tags, status, ownerId: c.req.query("owner") || undefined, limit: Number(c.req.query("limit")) || 100 });
  return c.json({ commitments: rows });
});

// ---------- Tasks tab: every member sees the tasks their own read surface allows ----------
const isAdmin = (u: { role: string }) => u.role === "admin" || u.role === "owner";
const owner = alias(users, "owner_u");
const assigner = alias(users, "assigner_u");

/** Scope: shared + the member's own DM tag + their private channels (readTags), plus DM-scoped tasks assigned TO them. Never wider. */
const visible = async (userId: string) => {
  const tags = await readTags({ channelId: "", isPrivate: false, isIm: true, userId });
  return or(inArray(commitments.scopeTag, tags), and(eq(commitments.ownerId, userId), like(commitments.scopeTag, "user\\_%"), like(commitments.sourceRef, "assign:%")))!;
};

export type TaskParams = Record<string, string | undefined>;
const STATUS_SET = new Set<string>(STATUSES);
const toDate = (s?: string) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };

/**
 * WHERE clause for the task list: the actor's read scope AND every filter in `params`
 * (status, owner, assigner, channel, mine, assignedByMe, overdue, unassigned, noDue, stale, dueSoon = "1", dueAfter, dueBefore, q).
 * Scope is always applied and never depends on a join, so exports can reuse it with a plain `from(commitments)`.
 */
export async function buildTaskFilter(params: TaskParams, actor: { id: string; role?: string }, now = new Date()) {
  const q = params;
  const f = flagSql(now);
  const statuses = (q.status ?? "").split(",").filter((s): s is Commitment["status"] => STATUS_SET.has(s));
  const pat = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  return and(
    await visible(actor.id),
    statuses.length ? inArray(commitments.status, statuses) : undefined,
    q.owner ? eq(commitments.ownerId, q.owner) : undefined,
    q.assigner ? eq(commitments.assignerId, q.assigner) : undefined,
    q.channel ? eq(commitments.channelId, q.channel) : undefined,
    q.mine === "1" ? eq(commitments.ownerId, actor.id) : undefined,
    q.assignedByMe === "1" ? eq(commitments.assignerId, actor.id) : undefined,
    q.overdue === "1" ? f.overdue : undefined,
    q.unassigned === "1" ? f.unassigned : undefined,
    q.noDue === "1" ? f.noDue : undefined,
    q.stale === "1" ? f.stale : undefined,
    q.dueSoon === "1" ? f.dueSoon : undefined,
    toDate(q.dueAfter) ? gte(commitments.dueAt, toDate(q.dueAfter)!) : undefined,
    toDate(q.dueBefore) ? lte(commitments.dueAt, toDate(q.dueBefore)!) : undefined,
    pat ? or(ilike(commitments.text, pat), ilike(commitments.ownerName, pat), sql`exists (select 1 from users u where u.id = ${commitments.ownerId} and u.name ilike ${pat})`) : undefined,
  );
}

/** The Tasks-tab query (scope-filtered to what `me` may read via buildTaskFilter). Shared by GET /tasks and the export routes so they can never disagree. */
export async function queryTasks(me: { id: string; role?: string }, q: TaskParams, now = new Date()) {
  const f = flagSql(now);
  return db.select({
    id: commitments.id, title: commitments.text, status: commitments.status, priority: commitments.priority, dueAt: commitments.dueAt,
    ownerId: commitments.ownerId, ownerName: sql<string | null>`coalesce(${owner.name}, ${commitments.ownerName})`, ownerAvatar: owner.avatarUrl,
    assignerId: commitments.assignerId, assignerName: assigner.name, assignerAvatar: assigner.avatarUrl,
    permalink: commitments.permalink, channelId: commitments.channelId, channelName: channels.name, scopeTag: commitments.scopeTag,
    sourceType: commitments.sourceType, createdAt: commitments.createdAt, completedAt: commitments.completedAt, lastNudgedAt: commitments.lastNudgedAt, externalRefs: commitments.externalRefs,
  }).from(commitments)
    .leftJoin(owner, eq(owner.id, commitments.ownerId)).leftJoin(assigner, eq(assigner.id, commitments.assignerId)).leftJoin(channels, eq(channels.id, commitments.channelId))
    .where(await buildTaskFilter(q, me, now))
    .orderBy(
      sql`case when ${commitments.status} in ('done','dropped') then 1 else 0 end`,
      sql`case when ${or(f.overdue, f.unassigned, f.noDue)} then 0 else 1 end`,
      sql`${commitments.dueAt} asc nulls last`, desc(commitments.createdAt))
    .limit(Math.min(Number(q.limit) || 300, 1000));
}

managerRoutes.get("/tasks", requireAuth(), async (c) => {
  const me = c.get("user");
  const now = new Date();
  const rows = await queryTasks(me, c.req.query(), now);
  // the viewer's own permission to act on each row, so the UI can hide what the API would refuse
  const tasks = rows.map(({ lastNudgedAt, ...r }) => ({
    ...r, overdue: !!r.dueAt && r.dueAt < now && !["done", "dropped"].includes(r.status),
    flags: taskFlags({ ...r, lastNudgedAt }, now),
    canEdit: isAdmin(me) || r.ownerId === me.id || r.assignerId === me.id, canReassign: isAdmin(me) || r.assignerId === me.id,
  }));
  // counts cover the whole readable scope (not the page, not the filters), so the summary chips stay stable
  return c.json({ tasks, me: me.id, counts: await taskCounts(await visible(me.id), now) });
});

const patchBody = z.object({
  status: z.enum(["open", "in_progress", "done", "dropped"]).optional(), ownerId: z.string().min(3).max(40).optional(),
  due: z.string().nullable().optional(), priority: z.enum(["normal", "urgent"]).optional(),
});

managerRoutes.patch("/tasks/:id", requireAuth(), async (c) => {
  const me = c.get("user");
  const b = await readBody(c, patchBody);
  let due: Date | null | undefined;
  if (b.due !== undefined) {
    due = b.due ? new Date(b.due) : null;
    if (due && Number.isNaN(due.getTime())) return c.json({ error: "invalid_due" }, 400);
  }
  const r = await changeTask(c.req.param("id"), { status: b.status, ownerId: b.ownerId, due, priority: b.priority }, { id: me.id, admin: isAdmin(me) });
  if (r.ok) return c.json({ ok: true, task: r.row });
  // changeTask answers "forbidden" for a task outside the caller's scope as well, so ids cannot be probed
  return c.json({ error: r.error, message: r.message }, r.error === "not_found" ? 404 : r.error === "forbidden" ? 403 : 400);
});

managerRoutes.post("/tasks", requireAuth(), async (c) => {
  const me = c.get("user");
  const b = await readBody(c, z.object({
    title: z.string().min(3).max(500), ownerId: z.string().min(3).max(40), due: z.string().nullable().optional(),
    priority: z.enum(["normal", "urgent"]).optional(), channelId: z.string().max(40).optional(), notify: z.boolean().optional(),
  }));
  const due = b.due ? new Date(b.due) : null;
  if (due && Number.isNaN(due.getTime())) return c.json({ error: "invalid_due" }, 400);
  const [o] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, b.ownerId), eq(users.isBot, false), eq(users.deactivated, false)));
  if (!o) return c.json({ error: "unknown_person" }, 400);
  let scopeTag = isAdmin(me) ? "shared" : `user_${me.id}`;
  if (b.channelId) {
    const [ch] = await db.select({ id: channels.id, im: channels.isIm }).from(channels).where(eq(channels.id, b.channelId));
    if (!ch || ch.im) return c.json({ error: "unknown_channel" }, 400);
    scopeTag = await channelScope(ch.id);
    if (!(await canRead({ scopeTag }, me.id))) return c.json({ error: "forbidden" }, 403);
  }
  const { row, created } = await upsertTask({
    title: b.title.trim(), ownerId: o.id, ownerName: o.name, assignerId: me.id, dueAt: due, priority: b.priority, channelId: b.channelId ?? null, threadTs: null,
    scopeTag, sourceKey: `web:${newId("w_")}`,
  });
  if (created && b.notify !== false && o.id !== me.id) await notifyTaskOwner(row, { assignerId: me.id });
  return c.json({ ok: true, created, task: row }, created ? 201 : 200);
});

/** Member-safe people picker: active humans, public profile fields only. */
managerRoutes.get("/people", requireAuth(), async (c) => {
  const rows = await db.select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, title: users.title }).from(users)
    .where(and(eq(users.isBot, false), eq(users.deactivated, false))).orderBy(users.name);
  return c.json({ people: rows });
});
