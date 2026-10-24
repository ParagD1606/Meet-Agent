import { Hono } from "hono";
import { log } from "../log";
import { requireAuth, type AppEnv } from "../auth/session";
import { z } from "zod";
import { authenticateToken } from "../mcp-server";
import { checkRate } from "../limits";
import { analyzeLiveMeeting, askLiveMeeting, getMeeting, ingestExtensionTranscript, listMeetings, syncRecentHuddles } from "../meetings";
import { httpError } from "./util";

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
meetingRoutes.post("/meetings/sync", requireAuth("admin"), async (c) => c.json(await syncRecentHuddles()));

const extSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  platform: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/),
  title: z.string().trim().min(1).max(240),
  lines: z.array(z.object({ speaker: z.string().trim().max(120).default(""), text: z.string().trim().min(1).max(4_000) })).min(1).max(20_000),
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
});

/**
 * Browser-extension upload. Authenticated by an API token (Configure > API tokens), not the session cookie,
 * so it is mounted outside /api and its CSRF check; there is no ambient credential to forge.
 */
export const extensionRoutes = new Hono();
extensionRoutes.post("/meetings", async (c) => {
  const userId = await authenticateToken(c.req.header("authorization"));
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const parsed = extSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 5) }, 400);
  return c.json(await ingestExtensionTranscript(userId, parsed.data), 201);
});
extensionRoutes.get("/ping", async (c) => (await authenticateToken(c.req.header("authorization"))) ? c.json({ ok: true }) : c.json({ error: "unauthorized" }, 401));

const liveLines = z.array(z.object({ speaker: z.string().trim().max(120).default(""), text: z.string().trim().min(1).max(4_000) })).min(1).max(20_000);
const toText = (lines: z.infer<typeof liveLines>) => lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");

/** Shared by the side panel's live endpoints: bearer auth, rate limit, body validation. */
async function live<S extends z.ZodType>(c: import("hono").Context, schema: S) {
  const userId = await authenticateToken(c.req.header("authorization"));
  if (!userId) return { res: c.json({ error: "unauthorized" }, 401) } as const;
  const rate = await checkRate({ userId, channelId: "ext-live", kind: "mcp" });
  if (!rate.ok) return { res: c.json({ error: "rate_limited", message: rate.message }, 429, { "retry-after": String(rate.retryAfterSec) }) } as const;
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return { res: c.json({ error: "invalid_body", issues: parsed.error.issues.slice(0, 5) }, 400) } as const;
  return { data: parsed.data as z.infer<S> } as const;
}

extensionRoutes.post("/ask", async (c) => {
  const r = await live(c, z.object({
    lines: liveLines, question: z.string().trim().min(1).max(1_000),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4_000) })).max(20).default([]),
  }));
  if ("res" in r) return r.res;
  try { return c.json({ answer: await askLiveMeeting(toText(r.data.lines), r.data.question, r.data.history) }); }
  catch (err) { log.warn("live ask failed", { error: String(err) }); return c.json({ error: "model_failed" }, 502); }
});

extensionRoutes.post("/analyze", async (c) => {
  const r = await live(c, z.object({ lines: liveLines }));
  if ("res" in r) return r.res;
  const speakers = [...new Set(r.data.lines.map((l) => l.speaker).filter(Boolean))].slice(0, 50);
  try { return c.json(await analyzeLiveMeeting(toText(r.data.lines), speakers)); }
  catch (err) { log.warn("live analyze failed", { error: String(err) }); return c.json({ error: "model_failed" }, 502); }
});
