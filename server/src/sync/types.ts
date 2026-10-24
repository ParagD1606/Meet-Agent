import { config } from "../config";

export type SyncProviderId = "gdrive" | "onedrive" | "notion" | "github" | "linear" | "jira" | "gmail" | "gcal";
/** Memory sources fed by an external system (not Slack, uploads or commands): their text may be written by outsiders. */
export const isExternalSource = (source: string) => (SYNC_PROVIDER_IDS as readonly string[]).includes(source);
export const SYNC_PROVIDER_IDS: readonly SyncProviderId[] = ["gdrive", "onedrive", "notion", "github", "linear", "jira", "gmail", "gcal"];
/** Connected with a pasted token/API key instead of OAuth. */
export const TOKEN_PROVIDER_IDS: readonly SyncProviderId[] = ["linear", "jira"];
/** Per-user sources: chunks land in user_<owner>, never shared; the user connects their own account. */
export const PERSONAL_PROVIDER_IDS: readonly SyncProviderId[] = ["gmail", "gcal"];

/** Stored encrypted in sync_sources.auth_enc. expiresAt is epoch ms. */
export type SyncAuth = { accessToken: string; refreshToken?: string; expiresAt?: number; extra?: Record<string, string> };
/** `parents` = ids of the containing folder/page/database/repo/team, used to apply the admin's selection. `inline` = text already fetched while listing. */
export type DocRef = { id: string; name: string; mimeType: string; parents?: string[]; permalink?: string; inline?: string };

/**
 * Admin-chosen scope of a source (sync_sources.selection). null/empty = nothing syncs. `ids` are folder/page ids (the
 * direct children of a folder match; a doc id matches itself); "*" means the admin explicitly chose the whole account.
 */
export type SyncSelection = { ids: string[]; /** ACL tag chunks are written to; absent = "shared". */ scopeTag?: string };
export const selectionIncludes = (sel: SyncSelection | null | undefined, doc: DocRef): boolean => {
  const ids = sel?.ids;
  if (!ids?.length) return false;
  return ids.includes("*") || ids.includes(doc.id) || Boolean(doc.parents?.some((p) => ids.includes(p)));
};
export type FetchedDoc = { name: string; mimeType: string; data: Buffer | string; permalink?: string };
/** One page of changes. `cursor` is what to persist after the page is processed; `done` = no more pages. */
export type ChangePage = { docs: DocRef[]; cursor: string | null; done: boolean };

export type SyncProvider = {
  id: SyncProviderId;
  /** False when the OAuth client id/secret env vars are missing: the provider is then disabled, not broken. */
  configured(): boolean;
  authUrl(state: string): string;
  exchange(code: string): Promise<SyncAuth>;
  refresh?(auth: SyncAuth): Promise<SyncAuth>;
  listChanges(auth: SyncAuth, cursor: string | null, selection?: SyncSelection | null): Promise<ChangePage>;
  fetchDoc(auth: SyncAuth, doc: DocRef): Promise<FetchedDoc | null>;
};

export const redirectUri = (p: SyncProviderId) => `${config.PUBLIC_URL.replace(/\/$/, "")}/sync/oauth/${p}/callback`;

/** ms to wait before retrying a rate-limited response (429, or 403 with Retry-After / exhausted quota); null = not rate limited. Capped at 60s. */
function retryAfterMs(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const limited = res.status === 429 || (res.status === 403 && (ra !== null || res.headers.get("x-ratelimit-remaining") === "0"));
  if (!limited) return null;
  const secs = ra !== null ? Number(ra) : reset ? Number(reset) - Date.now() / 1000 : 1;
  return Math.min(60_000, Math.max(0, (Number.isFinite(secs) ? secs : 1) * 1000));
}

const MAX_TOTAL_WAIT_MS = 60_000; // across all retries of one request
export async function http(url: string, init: RequestInit = {}, auth?: SyncAuth): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth && !headers.has("authorization")) headers.set("authorization", `Bearer ${auth.accessToken}`);
  let res: Response;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
    const wait = retryAfterMs(res);
    if (wait === null || attempt >= 3 || waited + wait > MAX_TOTAL_WAIT_MS) break;
    waited += wait;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}`);
  return res;
}
export const json = async <T>(url: string, init?: RequestInit, auth?: SyncAuth) => (await http(url, init, auth)).json() as Promise<T>;

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };
export const toAuth = (t: TokenResponse, prev?: SyncAuth): SyncAuth => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? prev?.refreshToken,
  expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
});
