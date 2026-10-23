import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { syncSources } from "../db/schema";
import { log } from "../log";
import { PROVIDERS, isProviderId, isRunning, runSync, startConnect } from "../sync";
import { SYNC_PROVIDER_IDS } from "../sync/types";
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
  return c.json(await startConnect(c, provider), 201);
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
  const rows = await db.update(syncSources).set({ selection, cursor: null }).where(eq(syncSources.id, c.req.param("id"))).returning();
  if (!rows.length) throw httpError(404, "not_found");
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
