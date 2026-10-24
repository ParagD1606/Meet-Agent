import { config } from "../config";
import { IntegrationError } from "./types";

let base = "https://api.github.com";
/** Tests only: points the client at a fake GitHub server. */
export const setGithubBaseForTest = (url: string | null) => { base = url ?? "https://api.github.com"; };

export type Cred = { token: string; kind: "app" | "pat"; installationId?: string };
export type Res = { status: number; headers: Headers; data: any };

/** Raw GitHub call: never throws on an HTTP status (callers decide), and hides network error text (it could echo the URL). The token only ever goes in the header. */
export async function ghx(token: string, method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<Res> {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "company-brain", authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
  } catch { throw new IntegrationError("upstream", "GitHub could not be reached"); }
}

export const isLimited = (r: Res) => r.status === 429 || (r.status === 403 && (!!r.headers.get("retry-after") || r.headers.get("x-ratelimit-remaining") === "0"));
export const retryAfter = (r: Res) => Number(r.headers.get("retry-after")) || undefined;

/** What to tell an admin when GitHub says the credential is not allowed to do something. Never contains the token. */
export function permissionHint(kind: Cred["kind"] | undefined, need: string, data?: { message?: string } | null): string {
  const msg = data?.message ?? "";
  if (kind === "app" || /integration/i.test(msg)) {
    const slug = config.GITHUB_APP_SLUG;
    return `the GitHub App is missing the permission "${need}". Add it at https://github.com/settings/apps/${slug ?? "<app-slug>"}/permissions (an organization-owned app: the organization's Settings > Developer settings > GitHub Apps), then an organization owner must approve the updated permissions on the installation page`;
  }
  return `the token is missing "${need}" (classic token: the \`repo\` scope; fine-grained token: Issues read & write on that repository)`;
}

/** Maps an HTTP failure to a user-safe IntegrationError. `need` names the permission a 403 is most likely about. */
export function failure(r: Res, kind?: Cred["kind"], need = "Issues: Read & write"): IntegrationError {
  if (isLimited(r)) { const t = retryAfter(r); return new IntegrationError("rate_limited", `GitHub rate limit reached${t ? `; retry in ${t}s` : ""}`, t); }
  if (r.status === 401) return new IntegrationError("unauthorized", "GitHub rejected the credentials (401); the token is invalid, expired or revoked");
  if (r.status === 403) return new IntegrationError("unauthorized", `GitHub rejected the credentials (403): ${permissionHint(kind, need, r.data)}`);
  if (r.status === 404) return new IntegrationError("not_found", "GitHub could not find the board, list or repository (404); check the repository name and that the credential can access it");
  if (r.status === 400 || r.status === 422) return new IntegrationError("invalid", `GitHub refused the request (${r.status})`);
  return new IntegrationError("upstream", `GitHub failed (${r.status})`);
}

/** Throws the mapped error unless 2xx; returns the JSON body. */
export async function gh(c: Cred, method: string, path: string, body?: unknown, query?: Record<string, string>, need?: string): Promise<any> {
  const r = await ghx(c.token, method, path, body, query);
  if (r.status < 200 || r.status >= 300) throw failure(r, c.kind, need);
  return r.data;
}
