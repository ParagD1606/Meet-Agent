import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { syncSources } from "../db/schema";
import { log } from "../log";
import { PROVIDERS, connectWithToken, isPersonal, isProviderId, isRunning, runSync, startConnect } from "../sync";
import { PERSONAL_PROVIDER_IDS, SYNC_PROVIDER_IDS, TOKEN_PROVIDER_IDS, type SyncProviderId, type SyncSelection } from "../sync/types";
import { httpError, readBody } from "./util";

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.get("/sync/sources", requireAuth("admin"), async (c) => {
  const rows = await db.select().from(syncSources);
  return c.json(rows.map((s) => ({
    id: s.id, provider: s.provider, connected: Boolean(s.authEnc), configured: PROVIDERS[s.provider].configured(),
    lastSyncAt: s.lastSyncAt, selection: s.selection ?? null, initialSyncDone: s.cursor !== null && !s.cursor.startsWith("full:"),
  })));
});

/** Starts the provider OAuth flow: creates the (unconnected) source and returns the consent URL. */
syncRoutes.post("/sync/sources", requireAuth("admin"), async (c) => {
  const { provider } = await readBody(c, z.object({ provider: z.enum(SYNC_PROVIDER_IDS as [string, ...string[]]) }));
  if (!isProviderId(provider)) throw httpError(400, "invalid_provider");
  if (!PROVIDERS[provider].configured()) throw httpError(400, "provider_not_configured", { provider });
  if (isPersonal(provider) || (TOKEN_PROVIDER_IDS as readonly string[]).includes(provider)) throw httpError(400, "use_other_connect_route", { provider });
  return c.json(await startConnect(c, provider), 201);
});

/** Token providers (github, linear, jira): admin pastes a PAT / API key; jira also needs baseUrl + email. */
syncRoutes.post("/sync/sources/token", requireAuth("admin"), async (c) => {
  const b = await readBody(c, z.object({
    provider: z.enum(TOKEN_PROVIDER_IDS as [string, ...string[]]), token: z.string().trim().min(8).max(500),
    baseUrl: z.string().url().optional(), email: z.string().email().optional(),
  }));
  try {
    return c.json({ id: await connectWithToken({ ...b, provider: b.provider as SyncProviderId }) }, 201);
  } catch (e) {
    throw httpError(400, "invalid_connection", { message: String(e instanceof Error ? e.message : e) });
  }
});

/** Personal sources (gmail, gcal): any member connects their OWN account; chunks are tagged user_<member> and never shared. */
syncRoutes.post("/sync/personal", requireAuth(), async (c) => {
  const { provider } = await readBody(c, z.object({ provider: z.enum(PERSONAL_PROVIDER_IDS as [string, ...string[]]) }));
  if (!PROVIDERS[provider as SyncProviderId].configured()) throw httpError(400, "provider_not_configured", { provider });
  return c.json(await startConnect(c, provider as SyncProviderId, c.get("user").id), 201);
});

const selectionBody = z.object({
  selection: z.object({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(500) }).nullable(),
});

/**
 * Chooses what a source syncs (folder / page ids; "*" = the whole account, an explicit choice). Nothing syncs until
 * this is set. Changing it restarts the source from the beginning so newly included items are picked up.
 */
syncRoutes.put("/sync/sources/:id", requireAuth("admin"), async (c) => {
  const { selection } = await readBody(c, selectionBody);
  const [cur] = await db.select().from(syncSources).where(eq(syncSources.id, c.req.param("id")));
  if (!cur) throw httpError(404, "not_found");
  if (isPersonal(cur.provider)) throw httpError(409, "personal_source"); // owner scope must not be editable
  // keep the ACL scope tag (a shared source has none; never let an edit widen or drop it)
  const scopeTag = (cur.selection as SyncSelection | null)?.scopeTag;
  const rows = await db.update(syncSources).set({ selection: selection && scopeTag ? { ...selection, scopeTag } : selection, cursor: null }).where(eq(syncSources.id, cur.id)).returning();
  return c.json({ id: rows[0]!.id, selection: rows[0]!.selection });
});

syncRoutes.post("/sync/sources/:id/run", requireAuth("admin"), async (c) => {
  const sourceId = c.req.param("id");
  const [s] = await db.select().from(syncSources).where(eq(syncSources.id, sourceId));
  if (!s) throw httpError(404, "not_found");
  if (!s.authEnc) throw httpError(409, "not_connected");
  if (!PROVIDERS[s.provider].configured()) throw httpError(400, "provider_not_configured", { provider: s.provider });
  if (!s.selection) throw httpError(409, "no_selection", { message: "Choose which folders or pages to sync first." });
  if (isRunning(sourceId)) throw httpError(409, "already_running");
  void runSync(sourceId).catch((e) => log.warn("manual sync failed", { sourceId, err: String(e) }));
  return c.json({ started: true }, 202);
});

syncRoutes.delete("/sync/sources/:id", requireAuth("admin"), async (c) => {
  const rows = await db.delete(syncSources).where(eq(syncSources.id, c.req.param("id"))).returning({ id: syncSources.id });
  if (!rows.length) throw httpError(404, "not_found");
  return c.json({ ok: true });
});
