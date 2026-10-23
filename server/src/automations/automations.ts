import { and, count, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { id as newId } from "../crypto";
import { db } from "../db";
import { automations, channelMembers, channels, users } from "../db/schema";
import { log } from "../log";

export const OWNER_CAP = 20;
export const MIN_INTERVAL_SECONDS = 3600;
export const MIN_DELAY_MS = 30_000;
export const PROMPT_MAX = 4000;
/** A digest whose prompt starts with this runs a research pipeline instead (the "watchlist"). */
export const RESEARCH_PREFIX = "research: ";

export type Automation = typeof automations.$inferSelect;
export type Role = "owner" | "admin" | "member";
/** `source` decides the private-channel rule: API => admins only; Slack => channel members only. */
export type Actor = { userId: string; role: Role; source?: "api" | "slack"; inChannelId?: string };

export class AutomationError extends Error {
  constructor(message: string, readonly code: "invalid" | "forbidden" | "not_found" | "limit") {
    super(message);
  }
}

export const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";

/** Smallest gap (seconds) between consecutive fires over the next 100 fires; null if invalid/never fires. */
export function cronMinGapSeconds(cron: string): number | null {
  if (cron.trim().split(/\s+/).length !== 5) return null; // 5-field only; no seconds column
  try {
    const it = CronExpressionParser.parse(cron.trim(), { tz: "UTC" });
    let prev = it.next().toDate().getTime();
    let min = Infinity;
    for (let i = 0; i < 100; i++) {
      const t = it.next().toDate().getTime();
      min = Math.min(min, t - prev);
      prev = t;
    }
    return Math.round(min / 1000);
  } catch {
    // Fewer than 101 fires left (e.g. yearly far out) still parses once next() worked; distinguish below.
    try {
      CronExpressionParser.parse(cron.trim(), { tz: "UTC" }).next();
      return Infinity;
    } catch {
      return null;
    }
  }
}

function checkCron(cron: string): string {
  const c = cron.trim();
  const gap = cronMinGapSeconds(c);
  if (gap === null) throw new AutomationError("invalid cron expression (use 5 fields, UTC)", "invalid");
  if (gap < MIN_INTERVAL_SECONDS)
    throw new AutomationError(`cron fires too often (every ${gap}s); minimum is ${MIN_INTERVAL_SECONDS}s`, "invalid");
  return c;
}

function toDate(v: Date | string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new AutomationError("runAt is not a valid date", "invalid");
  return d;
}

/** Fail closed: destination must be positively known, bot-visible, and pass the private-channel rule. */
async function assertDestination(actor: Actor, channelId: string) {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) throw new AutomationError("forbidden: channel not found or not accessible", "forbidden");
  if (ch.isIm) throw new AutomationError("use a null destination to DM the owner", "invalid");
  if (!ch.botIsMember) throw new AutomationError("the bot is not a member of that channel", "invalid");
  if (!ch.isPrivate) return;
  if (actor.source === "slack") {
    if (actor.inChannelId === channelId) return;
    const [m] = await db
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actor.userId)));
    if (!m) throw new AutomationError("forbidden: you are not a member of that private channel", "forbidden");
    return;
  }
  if (!isAdmin(actor)) throw new AutomationError("forbidden: private channels are admin-only", "forbidden");
}

async function getOwned(id: string, actor: Actor): Promise<Automation> {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  if (!row) throw new AutomationError("automation not found", "not_found");
  if (row.ownerUserId !== actor.userId && !isAdmin(actor)) throw new AutomationError("forbidden: not your automation", "forbidden");
  return row;
}

export type CreateInput = {
  ownerUserId?: string;
  kind: "digest" | "reminder";
  prompt: string;
  cron?: string | null;
  runAt?: Date | string | null;
  destChannelId?: string | null;
  enabled?: boolean;
};

function timing(cron: string | null | undefined, runAt: Date | string | null | undefined) {
  const c = cron?.trim() || null;
  if (!!c === !!runAt) throw new AutomationError("provide exactly one of cron or runAt", "invalid");
  if (c) return { cron: checkCron(c), runAt: null };
  const at = toDate(runAt!);
  if (at.getTime() < Date.now() + MIN_DELAY_MS) throw new AutomationError("runAt must be at least 30s in the future", "invalid");
  return { cron: null, runAt: at };
}

function checkPrompt(p: unknown): string {
  const prompt = typeof p === "string" ? p.trim() : "";
  if (!prompt) throw new AutomationError("prompt required", "invalid");
  if (prompt.length > PROMPT_MAX) throw new AutomationError(`prompt must be ${PROMPT_MAX} characters or fewer`, "invalid");
  return prompt;
}

/** Every check createAutomation makes, without writing. Throws AutomationError. */
export async function validateCreate(input: CreateInput, actor: Actor): Promise<{ ownerUserId: string; prompt: string; dest: string | null; t: ReturnType<typeof timing> }> {
  const ownerUserId = input.ownerUserId ?? actor.userId;
  if (ownerUserId !== actor.userId && !isAdmin(actor)) throw new AutomationError("forbidden: cannot create for someone else", "forbidden");
  if (input.kind !== "digest" && input.kind !== "reminder") throw new AutomationError("kind must be digest or reminder", "invalid");
  const prompt = checkPrompt(input.prompt);
  const t = timing(input.cron, input.runAt);
  const dest = input.destChannelId?.trim() || null;
  if (dest) await assertDestination(actor, dest);
  if (!isAdmin(actor)) {
    const [{ n }] = await db.select({ n: count() }).from(automations).where(eq(automations.ownerUserId, ownerUserId));
    if (n >= OWNER_CAP) throw new AutomationError(`automation limit reached (${OWNER_CAP} per person)`, "limit");
  }
  return { ownerUserId, prompt, dest, t };
}

export async function createAutomation(input: CreateInput, actor: Actor): Promise<Automation> {
  const { ownerUserId, prompt, dest, t } = await validateCreate(input, actor);
  const [row] = await db
    .insert(automations)
    .values({ id: newId("au_"), ownerUserId, kind: input.kind, prompt, ...t, destChannelId: dest, enabled: input.enabled ?? true })
    .returning();
  await scheduleOneOff(row!);
  return row!;
}

export async function listAutomations(actor: Actor): Promise<Automation[]> {
  const q = db.select().from(automations);
  return (isAdmin(actor) ? q : q.where(eq(automations.ownerUserId, actor.userId))).orderBy(automations.createdAt);
}

export type UpdatePatch = Partial<Pick<CreateInput, "prompt" | "cron" | "runAt" | "destChannelId" | "enabled">>;

export async function updateAutomation(id: string, patch: UpdatePatch, actor: Actor): Promise<Automation> {
  const cur = await getOwned(id, actor);
  const set: Partial<typeof automations.$inferInsert> = {};
  if (patch.prompt !== undefined) set.prompt = checkPrompt(patch.prompt);
  if (patch.enabled !== undefined) set.enabled = !!patch.enabled;
  if (patch.cron !== undefined || patch.runAt !== undefined) {
    const t = timing(patch.cron !== undefined ? patch.cron : patch.runAt ? null : cur.cron, patch.runAt !== undefined ? patch.runAt : patch.cron ? null : cur.runAt);
    Object.assign(set, t);
    if (patch.runAt) Object.assign(set, { lastRunAt: null, lastStatus: null });
  }
  if (patch.destChannelId !== undefined) {
    const dest = patch.destChannelId?.trim() || null;
    if (dest && dest !== cur.destChannelId) await assertDestination(actor, dest);
    set.destChannelId = dest;
  }
  if (!Object.keys(set).length) return cur;
  const [row] = await db.update(automations).set(set).where(eq(automations.id, id)).returning();
  await scheduleOneOff(row!);
  return row!;
}

export async function deleteAutomation(id: string, actor: Actor): Promise<void> {
  await getOwned(id, actor);
  await db.delete(automations).where(eq(automations.id, id));
}

export async function getRole(userId: string): Promise<Role> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role ?? "member";
}

/** One-offs get an exact-time pg-boss job; the minute tick is the safety net if this fails or jobs are down. */
async function scheduleOneOff(a: Automation): Promise<void> {
  if (!a.enabled || !a.runAt || a.lastRunAt) return;
  try {
    const { enqueueAutomation } = await import("../jobs");
    await enqueueAutomation(a.id, a.runAt);
  } catch (err) {
    log.warn("automation one-off enqueue failed; tick will pick it up", { id: a.id, err: String(err) });
  }
}
