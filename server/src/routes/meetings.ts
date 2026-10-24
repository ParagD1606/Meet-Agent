import { Hono } from "hono";
import { requireAuth, type AppEnv } from "../auth/session";
import { z } from "zod";
import { authenticateToken } from "../mcp-server";
import { getMeeting, ingestExtensionTranscript, listMeetings, syncRecentHuddles } from "../meetings";
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
