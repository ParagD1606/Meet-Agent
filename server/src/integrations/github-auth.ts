import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "../crypto";
import { db } from "../db";
import { syncSources } from "../db/schema";
import { log } from "../log";
import { githubAppConfigured, githubInstallationAuth } from "../sync/providers/github";
import type { SyncAuth } from "../sync/types";
import { ghx, type Cred } from "./github-api";
import { openToken, readIntegration } from "./types";

type Stored = { repo?: string; tokenEnc?: string; preferPat?: boolean };

/** Fresh installation tokens of every GitHub App installation connected under Sync (minted on demand, refreshed a minute before expiry, persisted like the sync does). */
export async function installationCreds(): Promise<Cred[]> {
  if (!githubAppConfigured()) return [];
  const out: Cred[] = [];
  const seen = new Set<string>();
  for (const src of await db.select().from(syncSources).where(eq(syncSources.provider, "github"))) {
    if (!src.authEnc) continue;
    try {
      let auth = JSON.parse(decrypt(src.authEnc)) as SyncAuth;
      const id = auth.extra?.installationId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!auth.expiresAt || auth.expiresAt < Date.now() + 60_000) {
        auth = await githubInstallationAuth(id);
        await db.update(syncSources).set({ authEnc: encrypt(JSON.stringify(auth)) }).where(eq(syncSources.id, src.id));
      }
      out.push({ token: auth.accessToken, kind: "app", installationId: id });
    } catch (e) { log.warn("github installation token unavailable", { source: src.id, err: e instanceof Error ? e.message.slice(0, 120) : "error" }); }
  }
  return out;
}

/** Cheap check (no token minting): is any credential present at all? */
export async function credentialInfo() {
  const s = await readIntegration<Stored>("github-issues");
  const rows = (await db.select({ a: syncSources.authEnc }).from(syncSources).where(eq(syncSources.provider, "github"))).filter((r) => r.a);
  const app = githubAppConfigured() && rows.length > 0;
  const hasPat = !!s?.tokenEnc;
  const kind = hasPat && (s?.preferPat || !app) ? "pat" : app ? "app" : "none";
  return { kind, appConfigured: githubAppConfigured(), installations: rows.length, hasPat, preferPat: !!s?.preferPat } as const;
}

/**
 * The credential the issue push uses: the GitHub App installation that can see `repo` (several installations are probed),
 * else the separately stored personal access token. `preferPat` (admin override) puts the token first.
 */
export async function githubCredential(repo?: string, o: { pat?: string } = {}): Promise<Cred | null> {
  const s = await readIntegration<Stored>("github-issues");
  const patTok = o.pat ?? (s?.tokenEnc ? openToken(s.tokenEnc) : null);
  const pat: Cred | null = patTok ? { token: patTok, kind: "pat" } : null;
  const apps = o.pat ? [] : await installationCreds();
  const ordered = o.pat || s?.preferPat ? [pat, ...apps] : apps.length ? apps : [pat];
  const list = ordered.filter((c): c is Cred => !!c);
  if (list.length <= 1 || !repo) return list[0] ?? null;
  for (const c of list) if ((await ghx(c.token, "GET", `/repos/${repo}`)).status === 200) return c;
  return list[0]!;
}
