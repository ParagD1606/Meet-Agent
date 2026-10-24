import { Hono } from "hono";
import { log } from "../log";
import { requireAuth, type AppEnv } from "../auth/session";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { id as newId, sha256 } from "../crypto";
import { db } from "../db";
import { apiTokens, users } from "../db/schema";
import { authenticateToken } from "../mcp-server";
import { checkRate } from "../limits";
import { analyzeLiveMeeting, askLiveMeeting, recallForMeeting, getMeeting, getOwnExtensionMeeting, ingestExtensionTranscript, listMeetings, meetingAssigneeCandidates, sendMeetingTaskDms, syncRecentHuddles, updateLiveNotes, updateMeetingTaskAssignee } from "../meetings";
import { suggestAssignees } from "../meetings/suggest";
import { httpError, readBody } from "./util";

export const meetingRoutes = new Hono<AppEnv>();

const actorOf = (u: AppEnv["Variables"]["user"]) => ({ userId: u.id, role: u.role });

meetingRoutes.get("/meetings", requireAuth(), async (c) => c.json(await listMeetings(actorOf(c.get("user")))));
meetingRoutes.get("/meetings/:id", requireAuth(), async (c) => {
  const meeting = await getMeeting(c.req.param("id"), actorOf(c.get("user")));
  if (!meeting) throw httpError(404, "not_found");
  return c.json(meeting);
});

// A workspace-wide import can discover transcripts in channels other than the caller's;
// keep the trigger with workspace admins while the resulting rows retain normal visibility rules.
meetingRoutes.post("/meetings/sync", requireAuth("admin"), async (c) => c.json(await syncRecentHuddles({ force: c.req.query("force") === "1" })));

/**
 * Any signed-in person can mint an extension-only token for themselves, so what the extension uploads belongs to them and shows on
 * their Meeting notes page. A new token replaces their previous one; it is returned once and only its hash is stored.
 */
meetingRoutes.post("/meetings/extension-token", requireAuth(), async (c) => {
  const user = c.get("user");
  await db.delete(apiTokens).where(and(eq(apiTokens.userId, user.id), eq(apiTokens.kind, "ext")));
  const token = `cbt_${randomBytes(32).toString("base64url")}`;
  await db.insert(apiTokens).values({ id: newId("tok_"), userId: user.id, name: "Browser extension", kind: "ext", hash: sha256(token) });
  return c.json({ token }, 201);
});

const taskIdsSchema = z.object({ taskIds: z.array(z.string().trim().min(1).max(80)).max(100).optional() });
const assigneeSchema = z.object({ assigneeId: z.string().trim().min(1).max(80).nullable() });

async function meetingFor(c: import("hono").Context<AppEnv>) {
  const id = c.req.param("id");
  if (!id) throw httpError(404, "not_found");
  const meeting = await getMeeting(id, actorOf(c.get("user")));
  if (!meeting) throw httpError(404, "not_found");
  return meeting;
}

/** Anyone who can view a meeting may send its task DMs; already delivered tasks are skipped. */
meetingRoutes.post("/meetings/:id/task-dms", requireAuth(), async (c) => {
  await meetingFor(c);
  const body = await readBody(c, taskIdsSchema.optional()); // the body is optional: no taskIds means every unsent task
  return c.json(await sendMeetingTaskDms(c.req.param("id"), body?.taskIds));
});

meetingRoutes.patch("/meetings/:id/tasks/:taskId", requireAuth(), async (c) => {
  await meetingFor(c);
  const body = await readBody(c, assigneeSchema);
  try { await updateMeetingTaskAssignee(c.req.param("id"), c.req.param("taskId"), body.assigneeId); }
  catch (err) { throw httpError(404, "not_found", { message: err instanceof Error ? err.message : String(err) }); }
  return c.json(await getMeeting(c.req.param("id"), actorOf(c.get("user"))));
});

/** Small, meeting-authorized typeahead instead of exposing the admin-only workspace user list. */
meetingRoutes.get("/meetings/:id/assignees", requireAuth(), async (c) => {
  await meetingFor(c);
  return c.json(await meetingAssigneeCandidates(c.req.query("q") ?? ""));
});

const extSchema = z.object({
  externalId: z.string().min(1),
  platform: z.string().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/),
  title: z.string().min(1),
  lines: z.array(z.object({ speaker: z.string(), text: z.string().min(1) })).min(1),
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
  decisions: z.array(z.string().min(1)).optional(),
  participants: z.array(z.string().min(1)).optional(),
  tasks: z.array(z.object({ title: z.string().min(1), assignee: z.string().optional(), assigneeId: z.string().optional(), due: z.string().optional(), done: z.boolean().optional() })).optional(),
});

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
/**
 * Cleans an upload before validation. A real call can produce an over-long participant label or an empty caption;
 * those are trimmed or dropped instead of rejecting a whole meeting.
 */
function sanitizeUpload(body: any) {
  if (!body || typeof body !== "object") return null;
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : undefined);
  return {
    externalId: clip(body.externalId, 200), platform: clip(body.platform, 32), title: clip(body.title, 240) || "Meeting",
    startedAt: body.startedAt, endedAt: body.endedAt,
    lines: (list(body.lines, 20_000) ?? []).map((l: any) => ({ speaker: clip(l?.speaker, 120), text: clip(l?.text, 4_000) })).filter((l: any) => l.text),
    participants: list(body.participants, 100)?.map((p) => clip(p, 120)).filter(Boolean),
    decisions: list(body.decisions, 50)?.map((d) => clip(d, 500)).filter(Boolean),
    tasks: list(body.tasks, 100)?.map((t: any) => ({ title: clip(t?.title, 240), assignee: clip(t?.assignee, 120) || undefined, assigneeId: clip(t?.assigneeId, 80) || undefined, due: clip(t?.due, 60) || undefined, done: t?.done === true })).filter((t: any) => t.title),
  };
}

/**
 * Browser-extension upload. Authenticated by an API token (Configure > API tokens), not the session cookie,
 * so it is mounted outside /api and its CSRF check; there is no ambient credential to forge.
 */
export const extensionRoutes = new Hono();
/** Extension tokens (made by each person for themselves) and the older admin-made API tokens both work here; only the latter open the MCP server. */
const extAuth = (c: import("hono").Context) => authenticateToken(c.req.header("authorization"), ["ext", "mcp"]);
extensionRoutes.post("/meetings", async (c) => {
  const userId = await extAuth(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const parsed = extSchema.safeParse(sanitizeUpload(await c.req.json().catch(() => null)));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  const { id, done } = await ingestExtensionTranscript(userId, parsed.data);
  if (c.req.header("x-wait") === "1") await done; // tests and tools can ask to wait for the final pass
  return c.json({ id }, 201);
});
extensionRoutes.get("/meetings/:id", async (c) => {
  const userId = await extAuth(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const m = await getOwnExtensionMeeting(userId, c.req.param("id"));
  return m ? c.json(m) : c.json({ error: "not_found" }, 404);
});
extensionRoutes.get("/ping", async (c) => {
  const userId = await extAuth(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return c.json({ ok: true, name: u?.name ?? null });
});

const liveLines = z.array(z.object({ speaker: z.string().trim().max(120).default(""), text: z.string().trim().min(1).max(4_000) })).min(1).max(20_000);
const liveCtx = z.object({
  title: z.string().max(240).optional(), startedAt: z.string().max(40).optional(),
  roster: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

/** Shared by the side panel's live endpoints: bearer auth, rate limit, body validation. */
async function live<S extends z.ZodType>(c: import("hono").Context, schema: S) {
  const userId = await extAuth(c);
  if (!userId) return { res: c.json({ error: "unauthorized" }, 401) } as const;
  const rate = await checkRate({ userId, channelId: "ext-live", kind: "mcp" });
  if (!rate.ok) return { res: c.json({ error: "rate_limited", message: rate.message }, 429, { "retry-after": String(rate.retryAfterSec) }) } as const;
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return { res: c.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 5) }, 400) } as const;
  return { data: parsed.data as z.infer<S>, userId } as const;
}

extensionRoutes.post("/ask", async (c) => {
  const r = await live(c, z.object({
    lines: liveLines, question: z.string().trim().min(1).max(1_000), context: liveCtx.extend({ notes: z.string().max(4_000).optional() }).default({}),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4_000) })).max(20).default([]),
  }));
  if ("res" in r) return r.res;
  try {
    const mem = await recallForMeeting(r.userId, `${r.data.question}\n${r.data.context.title ?? ""}`.trim(), { rewrite: true });
    return c.json({ answer: await askLiveMeeting(r.data.lines, r.data.question, r.data.history, r.data.context, mem.text), sources: mem.sources });
  }
  catch (err) { log.warn("live ask failed", { error: String(err) }); return c.json({ error: "model_failed" }, 502); }
});

extensionRoutes.post("/analyze", async (c) => {
  const r = await live(c, z.object({ lines: liveLines, context: liveCtx.default({}), known: z.array(z.string().max(300)).max(200).default([]) }));
  if ("res" in r) return r.res;
  const roster = [...new Set([...(r.data.context.roster ?? []), ...r.data.lines.map((l) => l.speaker).filter(Boolean)])].slice(0, 100);
  try {
    const mem = await recallForMeeting(r.userId, `${r.data.context.title ?? ""}\n${roster.join(", ")}\n${r.data.lines.slice(0, 3).map((l) => l.text).join(" ").slice(0, 300)}`, { budgetTokens: 1_500 });
    return c.json(await analyzeLiveMeeting(r.data.lines, { ...r.data.context, roster }, r.data.known, mem.text));
  }
  catch (err) { log.warn("live analyze failed", { error: String(err) }); return c.json({ error: "model_failed" }, 502); }
});

extensionRoutes.post("/notes", async (c) => {
  const r = await live(c, z.object({ lines: liveLines, offset: z.number().int().min(0).max(1_000_000).default(0), previous: z.string().max(8_000).default(""), context: liveCtx.default({}) }));
  if ("res" in r) return r.res;
  try { return c.json({ notes: await updateLiveNotes(r.data.lines, r.data.offset, r.data.previous, r.data.context) }); }
  catch (err) { log.warn("live notes failed", { error: String(err) }); return c.json({ error: "model_failed" }, 502); }
});

extensionRoutes.post("/suggest", async (c) => {
  const r = await live(c, z.object({
    tasks: z.array(z.object({ id: z.string().min(1).max(80), title: z.string().trim().min(1).max(300) })).min(1).max(12),
    roster: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    context: z.string().max(300).optional(),
  }));
  if ("res" in r) return r.res;
  try { return c.json(await suggestAssignees(r.userId, r.data.tasks, { roster: r.data.roster, context: r.data.context })); }
  catch (err) { log.warn("assignee suggestions failed", { error: String(err) }); return c.json({ error: "suggest_failed" }, 502); }
});
