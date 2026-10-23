import { config } from "../config";

export type SyncProviderId = "gdrive" | "onedrive" | "notion";
export const SYNC_PROVIDER_IDS: readonly SyncProviderId[] = ["gdrive", "onedrive", "notion"];

/** Stored encrypted in sync_sources.auth_enc. expiresAt is epoch ms. */
export type SyncAuth = { accessToken: string; refreshToken?: string; expiresAt?: number };
/** `parents` = ids of the containing folder/page/database, used to apply the admin's selection. */
export type DocRef = { id: string; name: string; mimeType: string; parents?: string[] };

/**
 * Admin-chosen scope of a source (sync_sources.selection). null/empty = nothing syncs. `ids` are folder/page ids (the
 * direct children of a folder match; a doc id matches itself); "*" means the admin explicitly chose the whole account.
 */
export type SyncSelection = { ids: string[] };
export const selectionIncludes = (sel: SyncSelection | null | undefined, doc: DocRef): boolean => {
  const ids = sel?.ids;
  if (!ids?.length) return false;
  return ids.includes("*") || ids.includes(doc.id) || Boolean(doc.parents?.some((p) => ids.includes(p)));
};
export type FetchedDoc = { name: string; mimeType: string; data: Buffer | string };
/** One page of changes. `cursor` is what to persist after the page is processed; `done` = no more pages. */
export type ChangePage = { docs: DocRef[]; cursor: string | null; done: boolean };

export type SyncProvider = {
  id: SyncProviderId;
  /** False when the OAuth client id/secret env vars are missing: the provider is then disabled, not broken. */
  configured(): boolean;
  authUrl(state: string): string;
  exchange(code: string): Promise<SyncAuth>;
  refresh?(auth: SyncAuth): Promise<SyncAuth>;
  listChanges(auth: SyncAuth, cursor: string | null): Promise<ChangePage>;
  fetchDoc(auth: SyncAuth, doc: DocRef): Promise<FetchedDoc | null>;
};

export const redirectUri = (p: SyncProviderId) => `${config.PUBLIC_URL.replace(/\/$/, "")}/sync/oauth/${p}/callback`;

export async function http(url: string, init: RequestInit = {}, auth?: SyncAuth): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth) headers.set("authorization", `Bearer ${auth.accessToken}`);
  const res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
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
