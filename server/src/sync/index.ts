import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type PgBoss from "pg-boss";
import { randomBytes } from "node:crypto";
import { cookieOpts, requireAuth } from "../auth/session";
import { decrypt, encrypt, id } from "../crypto";
import { db } from "../db";
import { settings, syncSources } from "../db/schema";
import { log, redactError } from "../log";
import { ingestDocument } from "../memory/ingest";
import { gdrive } from "./providers/gdrive";
import { github, githubInstallationAuth, verifyGithubInstallation } from "./providers/github";
import { gcal, gmail } from "./providers/google-personal";
import { jira } from "./providers/jira";
import { linear } from "./providers/linear";
import { notion } from "./providers/notion";
import { onedrive } from "./providers/onedrive";
import { PERSONAL_PROVIDER_IDS, SYNC_PROVIDER_IDS, TOKEN_PROVIDER_IDS, selectionIncludes, type SyncAuth, type SyncProvider, type SyncProviderId, type SyncSelection } from "./types";

export const PROVIDERS: Record<SyncProviderId, SyncProvider> = { gdrive, onedrive, notion, github, linear, jira, gmail, gcal };
export const isPersonal = (p: SyncProviderId) => (PERSONAL_PROVIDER_IDS as readonly string[]).includes(p);
export const isProviderId = (s: string): s is SyncProviderId => (SYNC_PROVIDER_IDS as readonly string[]).includes(s);

const MAX_PAGES_PER_RUN = 20;
const running = new Set<string>(); // ponytail: per-process guard; use a pg advisory lock if the server is ever scaled out

export type SyncResult = { pages: number; ingested: number; failed: number; done: boolean; skipped?: number };
export const isRunning = (sourceId: string) => running.has(sourceId);

/** Pulls changes since the stored cursor and ingests them into the source's scope tag ("shared", or user_X for personal sources). The cursor is saved after every page. */
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
  // personal sources (email, calendar) must carry their owner's tag: never fall back to "shared"
  const tag = selection.scopeTag ?? "shared";
  if (isPersonal(src.provider) && !tag.startsWith("user_")) throw new Error(`${src.provider} is a personal source without an owner`);
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
      const page = await provider.listChanges(auth, cursor, selection);
      res.pages++;
      for (const ref of page.docs) {
        if (!selectionIncludes(selection, ref)) { res.skipped = (res.skipped ?? 0) + 1; continue; }
        try {
          const doc = await provider.fetchDoc(auth, ref);
          if (!doc) continue;
          await ingestDocument({ tag, name: doc.name, mimeType: doc.mimeType, data: doc.data, source: src.provider, sourceRef: ref.id, permalink: doc.permalink ?? ref.permalink });
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
export async function startConnect(c: Parameters<typeof setCookie>[0], provider: SyncProviderId, ownerUserId?: string): Promise<{ id: string; authUrl: string }> {
  const p = PROVIDERS[provider];
  if (!p.configured()) throw new Error("provider_not_configured");
  const sourceId = id("sync_");
  if (isPersonal(provider) && !ownerUserId) throw new Error("personal_needs_owner");
  // the user's own connection is the consent: a personal source syncs everything it can see, into that user's private scope
  await db.insert(syncSources).values({ id: sourceId, provider: provider as never, ...(ownerUserId ? { selection: { ids: ["*"], scopeTag: `user_${ownerUserId}` } } : {}) });
  const state = randomBytes(16).toString("base64url");
  setCookie(c, STATE_COOKIE, `${state}.${sourceId}`, cookieOpts(900));
  return { id: sourceId, authUrl: p.authUrl(state) };
}

export function mountSyncOAuth(app: Hono<any>): void {
  // members may complete their own personal (email/calendar) connection; everything else stays admin-only
  app.get("/sync/oauth/:provider/callback", requireAuth(), async (c) => {
    const user = c.get("user");
    const provider = c.req.param("provider");
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const [state, sourceId] = (cookie ?? "").split(".");
    const code = c.req.query("code");
    const installationId = c.req.query("installation_id");
    if (c.req.query("error")) return c.redirect("/configure/sync?error=denied");
    if (!isProviderId(provider) || !state || !sourceId || c.req.query("state") !== state) {
      return c.json({ error: "invalid_state" }, 400);
    }
    const [src] = await db.select().from(syncSources).where(eq(syncSources.id, sourceId));
    if (!src || src.provider !== provider) return c.json({ error: "invalid_state" }, 400);
    const owner = (src.selection as SyncSelection | null)?.scopeTag;
    if (isPersonal(src.provider) ? owner !== `user_${user.id}` : user.role === "member") return c.json({ error: "forbidden" }, 403);
    try {
      // GitHub returns an installation id to the app setup URL. Verify it with the app JWT before storing it;
      // no browser-provided access token is ever accepted or persisted.
      let auth: SyncAuth;
      if (provider === "github") {
        if (!installationId) return c.json({ error: "invalid_state" }, 400);
        await verifyGithubInstallation(installationId);
        auth = await githubInstallationAuth(installationId);
      } else {
        if (!code) return c.json({ error: "invalid_state" }, 400);
        auth = await PROVIDERS[provider].exchange(code);
      }
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

/**
 * Jira's base URL receives the admin's API token (Basic auth), so it must be https on *.atlassian.net, or a host the admin listed in
 * settings `sync_jira_hosts` (self-hosted Jira). Never an IP literal, localhost or a private name.
 */
export async function assertJiraBase(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("baseUrl must be a valid URL"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("baseUrl must be https");
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".")) throw new Error("baseUrl must be a public hostname");
  if (host.endsWith(".atlassian.net")) return;
  const [row] = await db.select().from(settings).where(eq(settings.key, "sync_jira_hosts"));
  const allowed = Array.isArray(row?.value) ? (row!.value as unknown[]).map((h) => String(h).toLowerCase()) : [];
  if (!allowed.includes(host)) throw new Error("baseUrl must be on atlassian.net (or an allow-listed host)");
}

/** Connects a token-based source (Linear API key, Jira email + API token). Nothing syncs until a selection is set. */
export async function connectWithToken(a: { provider: SyncProviderId; token: string; baseUrl?: string; email?: string }): Promise<string> {
  if (!(TOKEN_PROVIDER_IDS as readonly string[]).includes(a.provider)) throw new Error("invalid_provider");
  if (a.provider === "jira" && (!a.baseUrl || !a.email)) throw new Error("jira needs baseUrl and email");
  if (a.provider === "jira") await assertJiraBase(a.baseUrl!);
  const auth: SyncAuth = { accessToken: a.token, ...(a.provider === "jira" ? { extra: { baseUrl: a.baseUrl!, email: a.email! } } : {}) };
  const sourceId = id("sync_");
  await db.insert(syncSources).values({ id: sourceId, provider: a.provider as never, authEnc: encrypt(JSON.stringify(auth)) });
  return sourceId;
}

