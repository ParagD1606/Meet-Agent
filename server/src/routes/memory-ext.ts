import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { hasRole, requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { channelMembers, channels, consolidationLog, memories, memoryReviews } from "../db/schema";
import { undoConsolidation } from "../memory/consolidate";
import { getCoreBlocks, setCoreBlockText, type BlockLabel } from "../memory/core-blocks";
import { listEpisodes, searchThreads } from "../memory/episodes";
import { getMemoryHistory } from "../memory/facts";
import { decideReview, listReviews } from "../memory/review";
import { SHARED_TAG, type SlackScope } from "../memory/scope";
import { httpError, readBody, readQuery } from "./util";

type User = AppEnv["Variables"]["user"];

/**
 * Parses `scope` = "company" | "channel_<id>" | "user" | "user_<id>" and enforces who may see it:
 * company = any member; channel = public channels or members of the private one; user = only yourself.
 * Anything else answers 404 so private scopes are not enumerable.
 */
async function resolveBlockScope(raw: string, user: User): Promise<{ label: BlockLabel; scope: SlackScope }> {
  const base = { isPrivate: false, isIm: false, userId: user.id };
  if (raw === "company") return { label: "company", scope: { channelId: "web", ...base } };
  if (raw === "user" || raw === `user_${user.id}`) return { label: "user", scope: { channelId: "web", ...base } };
  const m = /^channel_([A-Za-z0-9]+)$/.exec(raw);
  if (m) {
    const [ch] = await db.select({ id: channels.id, isPrivate: channels.isPrivate, isIm: channels.isIm }).from(channels).where(eq(channels.id, m[1]!));
    if (ch && !ch.isIm) {
      if (ch.isPrivate) {
        const [mem] = await db.select({ u: channelMembers.userId }).from(channelMembers)
          .where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.userId, user.id)));
        if (!mem) throw httpError(404, "not_found");
      }
      return { label: "channel", scope: { channelId: ch.id, isPrivate: ch.isPrivate, isIm: false, userId: user.id } };
    }
  }
  throw httpError(404, "not_found");
}

const scopeQ = z.object({ scope: z.string().max(80).default("company") });

export function mountMemoryExtRoutes(api: Hono<AppEnv>): void {
  api.get("/core-blocks", requireAuth(), async (c) => {
    const { scope: raw } = readQuery(c, scopeQ);
    const { label, scope } = await resolveBlockScope(raw, c.get("user"));
    const blocks = await getCoreBlocks(scope);
    const b = blocks[label];
    if (!b) throw httpError(404, "not_found");
    return c.json(b);
  });

  api.put("/core-blocks", requireAuth(), async (c) => {
    const user = c.get("user");
    // web sends {scope,text} in the body; ?scope= is also accepted
    const { scope: bodyScope, text } = await readBody(c, z.object({ scope: z.string().max(80).optional(), text: z.string().max(5000) }));
    const raw = bodyScope ?? readQuery(c, scopeQ).scope;
    const { label, scope } = await resolveBlockScope(raw, user);
    if (label === "company" && !hasRole(user.role, "admin")) throw httpError(403, "forbidden");
    const r = await setCoreBlockText({ scope, label, text, actor: { userId: user.id, role: user.role, agentContext: "primary" } });
    if (!r.ok) throw httpError(400, "rejected", { message: r.error, usage: r.usage });
    const b = (await getCoreBlocks(scope))[label];
    return c.json({ block: b, usage: r.usage, queuedForReview: Boolean(r.queuedForReview) });
  });

  // ---------- review queue (admin; shared-scope items only) ----------
  api.get("/reviews", requireAuth("admin"), async (c) => {
    const { status } = readQuery(c, z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() }));
    const rows = await listReviews(status);
    const out = [];
    for (const r of rows) {
      const payload = r.payload as Record<string, unknown>;
      if (r.kind === "core_block" && payload.tag !== SHARED_TAG) continue;
      let memory: { id: number; text: string } | null = null;
      if (r.memoryId != null) {
        const [m] = await db.select({ id: memories.id, text: memories.text, tag: memories.scopeTag }).from(memories).where(eq(memories.id, r.memoryId));
        if (m && m.tag !== SHARED_TAG) continue;
        memory = m ? { id: m.id, text: m.text } : null;
      }
      out.push({ ...r, memory });
    }
    return c.json(out);
  });

  api.post("/reviews/:id/decide", requireAuth("admin"), async (c) => {
    const { approve } = await readBody(c, z.object({ approve: z.boolean() }));
    const [rv] = await db.select({ id: memoryReviews.id }).from(memoryReviews).where(eq(memoryReviews.id, c.req.param("id")));
    if (!rv) throw httpError(404, "not_found");
    const r = await decideReview(rv.id, c.get("user").id, approve);
    if (!r.ok) throw httpError(r.error === "already_decided" ? 409 : 400, r.error ?? "failed");
    return c.json(r);
  });

  // ---------- consolidation log + undo (admin; undoConsolidation had no caller, so a bad nightly merge could not be reversed) ----------
  api.get("/consolidation-log", requireAuth("admin"), async (c) => {
    const { limit } = readQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }));
    const rows = await db.select().from(consolidationLog).orderBy(desc(consolidationLog.id)).limit(limit);
    // private scopes are reported as "private" only
    return c.json(rows.map((r) => ({ id: r.id, runId: r.runId, action: r.action, scopeTag: r.scopeTag === SHARED_TAG || !r.scopeTag ? r.scopeTag : "private", count: r.memoryIds.length, createdAt: r.createdAt, undoneAt: r.undoneAt })));
  });
  api.post("/consolidation-log/:id/undo", requireAuth("admin"), async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw httpError(400, "invalid_id");
    const r = await undoConsolidation(id, c.get("user").id);
    if (!r.ok) throw httpError(r.error === "not_found" ? 404 : 409, r.error ?? "failed");
    return c.json(r);
  });

  // ---------- history / episodes (web sees the org-wide shared tag only, like /api/memories) ----------
  api.get("/memories/:id/history", requireAuth(), async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw httpError(400, "invalid_id");
    const [row] = await db.select({ tag: memories.scopeTag }).from(memories).where(eq(memories.id, id));
    if (!row || row.tag !== SHARED_TAG) throw httpError(404, "not_found");
    const admin = hasRole(c.get("user").role, "admin");
    return c.json((await getMemoryHistory(id)).filter((m) => m.scopeTag === SHARED_TAG && (admin || m.reviewState === "ok")));
  });

  api.get("/episodes", requireAuth(), async (c) => {
    const { q, limit } = readQuery(c, z.object({ q: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }));
    if (q?.trim()) {
      const hits = await searchThreads({ scope: { channelId: "web", isPrivate: false, isIm: false, userId: null }, query: q.trim(), limit });
      return c.json(hits);
    }
    return c.json(await listEpisodes({ tags: [SHARED_TAG], limit }));
  });
}
