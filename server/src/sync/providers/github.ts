import { createPrivateKey, sign } from "node:crypto";
import { config } from "../../config";
import { http, json, type DocRef, type SyncAuth, type SyncProvider } from "../types";

let API = "https://api.github.com";
/** Tests only: points installation-token minting at a fake GitHub. */
export const setGithubAppApiForTest = (url: string | null) => { API = url ?? "https://api.github.com"; };
const H = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const PAGE = 100;
const MAX_PAGES_PER_REPO = 10; // ponytail: 1000 issues per repo per call; a capped repo holds the watermark back so the next call resumes
const MAX_COMMENTS = 30;

const REPO = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
const DOC_PATH = /^[\w.-]+(\/[\w.-]+)*$/; // no "..", no query/fragment characters
type Issue = { number: number; title: string; updated_at: string; html_url: string; pull_request?: unknown };
type Comment = { body?: string | null; user?: { login: string } | null };
type Entry = { type: string; name: string; path: string; html_url: string };

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const privateKey = () => {
  const raw = config.GITHUB_APP_PRIVATE_KEY!;
  return raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
};

/** Short-lived GitHub App JWT used only to mint an installation token. */
export function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const encoded = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.GITHUB_APP_ID }))}`;
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), createPrivateKey(privateKey())).toString("base64url")}`;
}

export const githubAppConfigured = () => Boolean(config.GITHUB_APP_ID && config.GITHUB_APP_SLUG && config.GITHUB_APP_PRIVATE_KEY);

/** Verifies that the selected installation belongs to this configured GitHub App. */
export async function verifyGithubInstallation(installationId: string): Promise<void> {
  if (!/^\d+$/.test(installationId)) throw new Error("invalid github installation id");
  await http(`${API}/app/installations/${installationId}`, { headers: { ...H, authorization: `Bearer ${appJwt()}` } });
}

/** Installation tokens expire in an hour, so they are minted on demand and never accepted from the browser. */
export async function githubInstallationAuth(installationId: string): Promise<SyncAuth> {
  if (!githubAppConfigured()) throw new Error("github app is not configured");
  if (!/^\d+$/.test(installationId)) throw new Error("invalid github installation id");
  const res = await json<{ token: string; expires_at: string }>(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST", headers: { ...H, authorization: `Bearer ${appJwt()}` },
  });
  const expiresAt = Date.parse(res.expires_at);
  if (!res.token || !Number.isFinite(expiresAt)) throw new Error("invalid github installation token response");
  return { accessToken: res.token, expiresAt, extra: { installationId } };
}

/**
 * GitHub App installation auth. Selection ids are "owner/name" repos ("*" = every repo the
 * installation sees). Ingests issue/PR title + body + comments, plus README and docs/*.md. Live state (open/closed/merged, labels,
 * assignees) is deliberately NOT ingested: the GitHub connection answers that live.
 * Cursor: ISO `updated_at` watermark (issues use `since`, sort=updated asc). Docs are re-read when the repo was pushed after it.
 */
export const github: SyncProvider = {
  id: "github",
  configured: githubAppConfigured,
  authUrl(state) { return `https://github.com/apps/${encodeURIComponent(config.GITHUB_APP_SLUG!)}/installations/new?state=${encodeURIComponent(state)}`; },
  async exchange() { throw new Error("GitHub connects with a personal access token"); },
  refresh: async (auth) => {
    const installationId = auth.extra?.installationId;
    if (!installationId) throw new Error("github app installation is missing");
    return githubInstallationAuth(installationId);
  },
  async listChanges(auth, cursor, selection) {
    const ids = selection?.ids ?? [];
    const repos = ids.includes("*")
      ? (await json<{ full_name: string }[]>(`${API}/user/repos?per_page=100&sort=pushed`, { headers: H }, auth)).map((r) => r.full_name)
      : ids;
    for (const r of repos) if (!REPO.test(r)) throw new Error(`invalid github repo id: ${r.slice(0, 80)}`);
    const docs: DocRef[] = [];
    let newest = cursor;
    const cappedAt: string[] = [];
    for (const repo of repos) {
      const info = await json<{ pushed_at: string | null }>(`${API}/repos/${repo}`, { headers: H }, auth);
      if (info.pushed_at && (!cursor || info.pushed_at > cursor)) {
        try {
          const readme = await json<{ html_url: string; name: string }>(`${API}/repos/${repo}/readme`, { headers: H }, auth);
          docs.push({ id: `${repo}:${readme.name}`, name: `${repo} ${readme.name}`, mimeType: "text/markdown", parents: [repo], permalink: readme.html_url });
        } catch { /* no readme */ }
        try {
          const dir = await json<Entry[]>(`${API}/repos/${repo}/contents/docs`, { headers: H }, auth);
          for (const f of dir) if (f.type === "file" && /\.(md|markdown|txt)$/i.test(f.name))
            docs.push({ id: `${repo}:${f.path}`, name: `${repo} ${f.path}`, mimeType: "text/markdown", parents: [repo], permalink: f.html_url });
        } catch { /* no docs dir */ }
      }
      let last: string | null = null;
      let capped = false;
      for (let page = 1; ; page++) {
        const q = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: String(PAGE), page: String(page), ...(cursor ? { since: cursor } : {}) });
        const items = await json<Issue[]>(`${API}/repos/${repo}/issues?${q}`, { headers: H }, auth);
        for (const i of items) {
          if (cursor && i.updated_at <= cursor) continue;
          last = i.updated_at;
          docs.push({ id: `${repo}#${i.number}`, name: `${repo}#${i.number} ${i.title}`, mimeType: "text/markdown", parents: [repo], permalink: i.html_url });
        }
        if (items.length < PAGE) break;
        if (page >= MAX_PAGES_PER_REPO) { capped = true; break; }
      }
      if (capped && last) cappedAt.push(last);
      else if (last && (!newest || last > newest)) newest = last;
    }
    // any capped repo holds the watermark at its own last item so its remainder is fetched next call (re-ingest is idempotent)
    if (cappedAt.length) return { docs, cursor: cappedAt.sort()[0]!, done: false };
    return { docs, cursor: newest, done: true };
  },
  async fetchDoc(auth, doc) {
    const [repo, rest] = doc.id.includes("#") ? doc.id.split("#") : doc.id.split(":");
    if (!repo || !REPO.test(repo) || !rest || (doc.id.includes("#") ? !/^\d+$/.test(rest) : !DOC_PATH.test(rest) || rest.split("/").includes(".."))) throw new Error("invalid github doc id");
    if (doc.id.includes("#")) {
      const issue = await json<{ title: string; body?: string | null }>(`${API}/repos/${repo}/issues/${rest}`, { headers: H }, auth);
      const comments = await json<Comment[]>(`${API}/repos/${repo}/issues/${rest}/comments?per_page=${MAX_COMMENTS}`, { headers: H }, auth);
      const thread = comments.filter((c) => c.body?.trim()).map((c) => `${c.user?.login ?? "someone"}: ${c.body!.trim()}`);
      const text = `# ${doc.name}\n\n${issue.body?.trim() ?? ""}${thread.length ? `\n\nDiscussion:\n${thread.join("\n\n")}` : ""}`;
      return { name: doc.name, mimeType: "text/markdown", data: text, permalink: doc.permalink };
    }
    const res = await http(`${API}/repos/${repo}/contents/${rest}`, { headers: { ...H, accept: "application/vnd.github.raw+json" } }, auth);
    return { name: doc.name, mimeType: "text/markdown", data: await res.text(), permalink: doc.permalink };
  },
};
