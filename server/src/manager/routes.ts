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

managerRoutes.get("/tasks", requireAuth(), async (c) => {
  const me = c.get("user");
  const q = c.req.query();
  const now = new Date();
  const statuses = (q.status ?? "").split(",").filter((s): s is Commitment["status"] => STATUSES.includes(s as never));
  const date = (s?: string) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };
  const pat = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db.select({
    id: commitments.id, title: commitments.text, status: commitments.status, priority: commitments.priority, dueAt: commitments.dueAt,
    ownerId: commitments.ownerId, ownerName: sql<string | null>`coalesce(${owner.name}, ${commitments.ownerName})`, ownerAvatar: owner.avatarUrl,
    assignerId: commitments.assignerId, assignerName: assigner.name, assignerAvatar: assigner.avatarUrl,
    permalink: commitments.permalink, channelId: commitments.channelId, channelName: channels.name, scopeTag: commitments.scopeTag,
    sourceType: commitments.sourceType, createdAt: commitments.createdAt, completedAt: commitments.completedAt,
  }).from(commitments)
    .leftJoin(owner, eq(owner.id, commitments.ownerId)).leftJoin(assigner, eq(assigner.id, commitments.assignerId)).leftJoin(channels, eq(channels.id, commitments.channelId))
    .where(and(
      await visible(me.id),
      statuses.length ? inArray(commitments.status, statuses) : undefined,
      q.owner ? eq(commitments.ownerId, q.owner) : undefined,
      q.assigner ? eq(commitments.assignerId, q.assigner) : undefined,
      q.channel ? eq(commitments.channelId, q.channel) : undefined,
      q.mine === "1" ? eq(commitments.ownerId, me.id) : undefined,
      q.assignedByMe === "1" ? eq(commitments.assignerId, me.id) : undefined,
      q.overdue === "1" ? and(inArray(commitments.status, [...ACTIVE]), lte(commitments.dueAt, now)) : undefined,
      date(q.dueAfter) ? gte(commitments.dueAt, date(q.dueAfter)!) : undefined,
      date(q.dueBefore) ? lte(commitments.dueAt, date(q.dueBefore)!) : undefined,
      pat ? or(ilike(commitments.text, pat), ilike(owner.name, pat), ilike(commitments.ownerName, pat)) : undefined,
    ))
    .orderBy(sql`case when ${commitments.status} in ('done','dropped') then 1 else 0 end`, sql`${commitments.dueAt} asc nulls last`, desc(commitments.createdAt))
    .limit(Math.min(Number(q.limit) || 300, 1000));
  // the viewer's own permission to act on each row, so the UI can hide what the API would refuse
  const tasks = rows.map((r) => ({
    ...r, overdue: !!r.dueAt && r.dueAt < now && !["done", "dropped"].includes(r.status),
    canEdit: isAdmin(me) || r.ownerId === me.id || r.assignerId === me.id, canReassign: isAdmin(me) || r.assignerId === me.id,
  }));
  return c.json({ tasks, me: me.id });
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
