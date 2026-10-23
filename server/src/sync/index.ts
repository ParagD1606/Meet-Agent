import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type PgBoss from "pg-boss";
import { randomBytes } from "node:crypto";
import { cookieOpts, requireAuth } from "../auth/session";
import { decrypt, encrypt, id } from "../crypto";
import { db } from "../db";
import { syncSources } from "../db/schema";
import { log, redactError } from "../log";
import { ingestDocument } from "../memory/ingest";
import { gdrive } from "./providers/gdrive";
import { notion } from "./providers/notion";
import { onedrive } from "./providers/onedrive";
import { SYNC_PROVIDER_IDS, selectionIncludes, type SyncAuth, type SyncProvider, type SyncProviderId, type SyncSelection } from "./types";

export const PROVIDERS: Record<SyncProviderId, SyncProvider> = { gdrive, onedrive, notion };
export const isProviderId = (s: string): s is SyncProviderId => (SYNC_PROVIDER_IDS as readonly string[]).includes(s);

const MAX_PAGES_PER_RUN = 20;
const running = new Set<string>(); // ponytail: per-process guard; use a pg advisory lock if the server is ever scaled out

export type SyncResult = { pages: number; ingested: number; failed: number; done: boolean; skipped?: number };
export const isRunning = (sourceId: string) => running.has(sourceId);

/** Pulls changes since the stored cursor and ingests them into the "shared" memory tag. The cursor is saved after every page. */
export async function runSync(sourceId: string): Promise<SyncResult> {
  const [src] = await db.select().from(syncSources).where(eq(syncSources.id, sourceId));
  if (!src) throw new Error("sync source not found");
  const provider = PROVIDERS[src.provider];
  if (!provider.configured()) throw new Error(`${src.provider} sync is not configured on this server`);
  if (!src.authEnc) throw new Error("sync source is not connected yet");
  const selection = (src.selection as SyncSelection | null) ?? null;
  if (!selection?.ids?.length) {
    // never whole-drive by default: an admin must choose folders/pages (or explicitly "*") first
    log.info("sync skipped: no selection", { sourceId, provider: src.provider });
    return { pages: 0, ingested: 0, failed: 0, done: true, skipped: 0 };
  }
  if (running.has(sourceId)) throw new Error("sync already running");
  running.add(sourceId);
  try {
    let auth = JSON.parse(decrypt(src.authEnc)) as SyncAuth;
    if (provider.refresh && auth.expiresAt && auth.expiresAt < Date.now() + 60_000) {
      auth = await provider.refresh(auth);
      await db.update(syncSources).set({ authEnc: encrypt(JSON.stringify(auth)) }).where(eq(syncSources.id, sourceId));
    }
    let cursor = src.cursor;
    const res: SyncResult = { pages: 0, ingested: 0, failed: 0, done: false };
    while (res.pages < MAX_PAGES_PER_RUN && !res.done) {
      const page = await provider.listChanges(auth, cursor);
      res.pages++;
      for (const ref of page.docs) {
        if (!selectionIncludes(selection, ref)) { res.skipped = (res.skipped ?? 0) + 1; continue; }
        try {
          const doc = await provider.fetchDoc(auth, ref);
          if (!doc) continue;
          await ingestDocument({ tag: "shared", name: doc.name, mimeType: doc.mimeType, data: doc.data, source: src.provider, sourceRef: ref.id });
          res.ingested++;
        } catch (e) {
          // ponytail: a doc that keeps failing is skipped (cursor still advances); add per-doc retry state if that bites.
          res.failed++;
          log.warn("sync doc failed", { provider: src.provider, doc: ref.id, err: redactError(e) });
        }
      }
      cursor = page.cursor;
      res.done = page.done;
      await db.update(syncSources).set({ cursor, lastSyncAt: new Date() }).where(eq(syncSources.id, sourceId));
    }
    log.info("sync finished", { sourceId, provider: src.provider, ...res });
    return res;
  } finally {
    running.delete(sourceId);
  }
}

export async function runAllSyncs(): Promise<void> {
  for (const s of await db.select({ id: syncSources.id, authEnc: syncSources.authEnc }).from(syncSources)) {
    if (!s.authEnc) continue;
    await runSync(s.id).catch((e) => log.warn("scheduled sync failed", { sourceId: s.id, err: String(e) }));
  }
}

/** Hourly cron through pg-boss. Call after the boss has started. */
export async function registerSyncJobs(boss: PgBoss): Promise<void> {
  // retry transient failures twice; a stuck run is expired after 30 minutes instead of blocking the queue
  await boss.createQueue("sync-all", { name: "sync-all", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 30 * 60 });
  await boss.schedule("sync-all", "0 * * * *");
  await boss.work("sync-all", async () => { await runAllSyncs(); });
}

// ---------- OAuth ----------
const STATE_COOKIE = "brain_sync_state";

/** Creates a not-yet-connected source and returns the provider consent URL. State lives in a short-lived httpOnly cookie. */
export async function startConnect(c: Parameters<typeof setCookie>[0], provider: SyncProviderId): Promise<{ id: string; authUrl: string }> {
  const p = PROVIDERS[provider];
  if (!p.configured()) throw new Error("provider_not_configured");
  const sourceId = id("sync_");
  await db.insert(syncSources).values({ id: sourceId, provider });
  const state = randomBytes(16).toString("base64url");
  setCookie(c, STATE_COOKIE, `${state}.${sourceId}`, cookieOpts(900));
  return { id: sourceId, authUrl: p.authUrl(state) };
}

export function mountSyncOAuth(app: Hono<any>): void {
  app.get("/sync/oauth/:provider/callback", requireAuth("admin"), async (c) => {
    const provider = c.req.param("provider");
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const [state, sourceId] = (cookie ?? "").split(".");
    const code = c.req.query("code");
    if (c.req.query("error")) return c.redirect("/configure/sync?error=denied");
    if (!isProviderId(provider) || !code || !state || !sourceId || c.req.query("state") !== state) {
      return c.json({ error: "invalid_state" }, 400);
    }
    const [src] = await db.select().from(syncSources).where(eq(syncSources.id, sourceId));
    if (!src || src.provider !== provider) return c.json({ error: "invalid_state" }, 400);
    try {
      const auth = await PROVIDERS[provider].exchange(code);
      await db.update(syncSources).set({ authEnc: encrypt(JSON.stringify(auth)), cursor: null }).where(eq(syncSources.id, sourceId));
    } catch (e) {
      log.error("sync oauth exchange failed", { provider, err: String(e) });
      return c.redirect("/configure/sync?error=exchange");
    }
    // Kick off the first sync without blocking the redirect.
    void runSync(sourceId).catch((e) => log.warn("initial sync failed", { sourceId, err: String(e) }));
    return c.redirect("/configure/sync?connected=1");
  });
}

