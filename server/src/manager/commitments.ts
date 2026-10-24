import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, commitments, episodes, meetings, memories, settings, turns, users } from "../db/schema";
import { log } from "../log";
import { completeJson } from "../memory/llm";
import { SHARED_TAG } from "../memory/scope";

export type Commitment = typeof commitments.$inferSelect;
export const ACTIVE = ["open", "overdue"] as const;
const DAY = 86_400_000;

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value as T | undefined;
}
export const putSetting = (key: string, value: unknown) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

// ---------- owner / channel resolution ----------
/** Slack id from "<@U1>" / "U1", else an exact (then unique partial) name match among active humans. Unresolved -> id null. */
export async function resolveOwner(raw: string | null | undefined): Promise<{ id: string | null; name: string | null }> {
  const s = (raw ?? "").trim();
  if (!s) return { id: null, name: null };
  const m = s.match(/^<?@?([UW][A-Z0-9]{3,})(?:\|[^>]*)?>?$/);
  const base = and(eq(users.isBot, false), eq(users.deactivated, false));
  if (m) {
    const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(and(base, eq(users.id, m[1]!)));
    return { id: m[1]!, name: u?.name ?? null };
  }
  const name = s.replace(/^@/, "");
  const exact = await db.select({ id: users.id, name: users.name }).from(users).where(and(base, sql`lower(${users.name}) = lower(${name})`));
  const rows = exact.length ? exact : await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(base, sql`lower(${users.name}) like ${`%${name.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`}`)).limit(2);
  return rows.length === 1 ? { id: rows[0]!.id, name: rows[0]!.name } : { id: null, name };
}

/** Channel a fact came from: source_ref is either a channel id or a thread ts. */
async function channelOfRef(ref: string | null): Promise<{ channelId: string | null; threadTs: string | null }> {
  if (!ref) return { channelId: null, threadTs: null };
  const [c] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, ref));
  if (c) return { channelId: c.id, threadTs: null };
  const [e] = await db.select({ c: episodes.channelId }).from(episodes).where(eq(episodes.threadTs, ref)).limit(1);
  if (e) return { channelId: e.c, threadTs: ref };
  const [t] = await db.select({ c: turns.channelId }).from(turns).where(eq(turns.threadTs, ref)).limit(1);
  return t ? { channelId: t.c, threadTs: ref } : { channelId: null, threadTs: null };
}

const channelScope = async (channelId: string) => {
  const [c] = await db.select({ p: channels.isPrivate }).from(channels).where(eq(channels.id, channelId));
  return c?.p ? `channel_${channelId}` : SHARED_TAG;
};

// ---------- writing ----------
export type NewCommitment = {
  ownerId?: string | null; ownerName?: string | null; text: string; dueAt?: Date | null;
  sourceType: Commitment["sourceType"]; sourceRef: string; permalink?: string | null;
  channelId?: string | null; threadTs?: string | null; scopeTag: string;
};

/** Idempotent on sourceRef. Returns true when a new row was written. */
export async function addCommitment(c: NewCommitment): Promise<boolean> {
  const r = await db.insert(commitments).values({
    id: newId("cm_"), ownerId: c.ownerId ?? null, ownerName: c.ownerName ?? null, text: c.text.slice(0, 500),
    dueAt: c.dueAt ?? null, sourceType: c.sourceType, sourceRef: c.sourceRef, permalink: c.permalink ?? null,
    channelId: c.channelId ?? null, threadTs: c.threadTs ?? null, scopeTag: c.scopeTag,
  }).onConflictDoNothing().returning({ id: commitments.id });
  return r.length > 0;
}

const parseDue = (s: unknown): Date | null => {
  if (typeof s !== "string" || !s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------- message-text extractor (cheap model) ----------
const extracted = z.object({
  commitments: z.array(z.object({ owner: z.string().nullable().optional(), text: z.string().min(3), due: z.string().nullable().optional() })).max(10),
});
const SYSTEM = `You extract explicit commitments (someone promised or was assigned to do something) from workplace text.
Only include items where a specific person or team owns a concrete action. Never invent an owner or a due date; use null when unknown.
"owner" is a Slack user id (<@U123> or U123) if shown, else the name as written. "due" is an ISO date (YYYY-MM-DD) resolved against today's date, else null.
Return JSON only: {"commitments":[{"owner":null,"text":"...","due":null}]}. Return {"commitments":[]} when there are none.`;
/** Cheap pre-filter so the model only sees text that sounds like a promise. */
export const COMMIT_CUE = /\b(will|i'll|we'll|going to|gonna|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|eod|eow|end of|next|\d)|due|deadline|action item|todo|to-do|assigned|owner|take care of|on it|follow up|responsible)\b/i;

export type ExtractCtx = {
  sourceRef: string; sourceType: Commitment["sourceType"]; scopeTag: string;
  channelId?: string | null; threadTs?: string | null; permalink?: string | null; now?: Date;
};

/** Extracts commitments from free text (a message, thread summary, decision) and stores them. Exported so a writeback hook can call it. */
export async function extractFromText(text: string, ctx: ExtractCtx): Promise<number> {
  if (!COMMIT_CUE.test(text)) return 0;
  const today = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  const out = await completeJson({ system: SYSTEM, prompt: `Today: ${today}\n\nTEXT:\n${text.slice(0, 4000)}`, role: "extract", maxOutputTokens: 600 }, extracted);
  let n = 0;
  for (const [i, c] of out.commitments.entries()) {
    const owner = await resolveOwner(c.owner);
    if (await addCommitment({ ...ctx, ownerId: owner.id, ownerName: owner.name, text: c.text, dueAt: parseDue(c.due), sourceRef: `${ctx.sourceRef}:${i}` })) n++;
  }
  return n;
}

// ---------- batch extraction from facts, thread episodes and meetings ----------
const CURSOR = "manager_extract_cursor";

/** Processes everything captured since the last run (first run: last 3 days). Idempotent; the cursor only advances when nothing failed. */
export async function runExtraction(now = new Date()): Promise<{ created: number; failed: number }> {
  const since = new Date((await getSetting<string>(CURSOR)) ?? now.getTime() - 3 * DAY);
  let created = 0, failed = 0;
  const guard = async (f: () => Promise<number>) => { try { created += await f(); } catch (e) { failed++; log.warn("commitment extraction failed", { err: String(e).slice(0, 200) }); } };

  const facts = await db.select().from(memories).where(and(
    eq(memories.kind, "fact"), eq(memories.status, "active"), eq(memories.reviewState, "ok"),
    inArray(memories.factType, ["decision", "procedure"]), gt(memories.createdAt, since), lte(memories.createdAt, now),
  )).limit(200);
  for (const f of facts) {
    const where = f.scopeTag.startsWith("channel_") ? { channelId: f.scopeTag.slice(8), threadTs: null } : await channelOfRef(f.sourceRef);
    await guard(() => extractFromText(f.text, { sourceRef: `fact:${f.id}`, sourceType: "fact", scopeTag: f.scopeTag, permalink: f.permalink, now, ...where }));
  }

  const eps = await db.select().from(episodes).where(and(gt(episodes.createdAt, since), lte(episodes.createdAt, now))).limit(200);
  for (const e of eps) {
    await guard(() => extractFromText(e.summary, { sourceRef: `episode:${e.id}`, sourceType: "message", scopeTag: e.scopeTag, channelId: e.channelId, threadTs: e.threadTs, permalink: e.permalink, now }));
  }

  const ms = await db.select().from(meetings).where(and(eq(meetings.status, "ready"), gt(meetings.updatedAt, since), lte(meetings.updatedAt, now))).limit(100);
  for (const m of ms) {
    const scopeTag = await channelScope(m.channelId);
    const tasks = Array.isArray(m.tasks) ? (m.tasks as Record<string, unknown>[]) : [];
    await guard(async () => {
      let n = 0;
      for (const [i, t] of tasks.entries()) {
        const title = typeof t.title === "string" ? t.title : "";
        if (!title) continue;
        const owner = await resolveOwner((t.assigneeId as string) || (t.assigneeName as string) || null);
        if (await addCommitment({ ownerId: owner.id, ownerName: owner.name, text: title, dueAt: parseDue(t.dueDate), sourceType: "meeting", sourceRef: `meeting:${m.id}:${i}`, channelId: m.channelId, threadTs: m.threadTs, scopeTag })) n++;
      }
      return n;
    });
  }

  if (!failed) await putSetting(CURSOR, now.toISOString());
  return { created, failed };
}

// ---------- status ----------
/** Flips open commitments whose due date has passed to overdue. */
export async function markOverdue(now = new Date()): Promise<number> {
  const r = await db.update(commitments).set({ status: "overdue" }).where(and(eq(commitments.status, "open"), lte(commitments.dueAt, now))).returning({ id: commitments.id });
  return r.length;
}

/** Owner (or admin) closes a commitment. Returns the row, or null when missing / not allowed / already closed. */
export async function resolveCommitment(id: string, status: "done" | "dropped", by: { id: string; admin?: boolean }): Promise<Commitment | null> {
  const [row] = await db.update(commitments).set({ status, completedAt: new Date() })
    .where(and(eq(commitments.id, id), inArray(commitments.status, [...ACTIVE]), by.admin ? undefined : eq(commitments.ownerId, by.id)))
    .returning();
  return row ?? null;
}

/** Commitments the holder of `tags` may read (readTags of the asker). Never widens past the scope model. */
export async function listCommitments(a: { tags: string[]; status?: Commitment["status"][]; ownerId?: string; limit?: number }): Promise<Commitment[]> {
  if (!a.tags.length) return [];
  return db.select().from(commitments).where(and(
    inArray(commitments.scopeTag, a.tags),
    a.status?.length ? inArray(commitments.status, a.status) : undefined,
    a.ownerId ? eq(commitments.ownerId, a.ownerId) : undefined,
  )).orderBy(sql`${commitments.dueAt} asc nulls last`, desc(commitments.createdAt)).limit(Math.min(a.limit ?? 100, 500));
}
