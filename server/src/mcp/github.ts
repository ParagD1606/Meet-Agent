import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { McpReauthRequired, readAuth, updateAuth, writeAuth } from "./oauth";
import type { ConnectionRow, McpSession, McpToolInfo } from "./client";

const API = "https://api.github.com";
const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const STATE_TTL_MS = 10 * 60_000;

const configured = () => {
  if (!config.GITHUB_APP_CLIENT_ID || !config.GITHUB_APP_CLIENT_SECRET) throw new Error("GitHub OAuth is not configured yet. Ask an admin to add the GitHub App Client ID and Client Secret.");
  return { clientId: config.GITHUB_APP_CLIENT_ID, clientSecret: config.GITHUB_APP_CLIENT_SECRET };
};
const callbackUrl = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/github/oauth/callback`;
const verifier = () => randomBytes(48).toString("base64url");
const challenge = (v: string) => createHash("sha256").update(v).digest("base64url");

/** Start a GitHub App user authorization. The connection remains personal by construction. */
export async function startGithubConnect(connectionId: string): Promise<{ authUrl: string }> {
  const { clientId } = configured();
  const codeVerifier = verifier();
  const state = `${connectionId}.${randomBytes(24).toString("base64url")}`;
  await writeAuth(connectionId, { accessToken: undefined, refreshToken: undefined, expiresAt: undefined, state, stateExpiresAt: Date.now() + STATE_TTL_MS, codeVerifier }, true);
  await db.update(mcpConnections).set({ status: "pending", lastError: null }).where(eq(mcpConnections.id, connectionId));
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", callbackUrl());
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge(codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  return { authUrl: u.toString() };
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; error?: string; error_description?: string };
async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = configured();
  const r = await fetch(TOKEN, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }) });
  const result = await r.json().catch(() => ({})) as TokenResponse;
  if (!r.ok || result.error || !result.access_token) throw new Error(result.error_description || result.error || "GitHub did not issue an access token");
  return result;
}

/** Exchange the callback code and bind the resulting account name to the connection. */
export async function finishGithubConnect(code: string, state: string, userId: string): Promise<{ connectionId: string; label: string }> {
  const connectionId = state.split(".")[0] ?? "";
  const [conn] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  const auth = conn ? await readAuth(connectionId) : undefined;
  if (!conn || conn.provider !== "github" || conn.scope !== "user" || conn.ownerUserId !== userId || !auth?.state || auth.state !== state || !auth.stateExpiresAt || auth.stateExpiresAt < Date.now() || !auth.codeVerifier) throw new Error("invalid or expired GitHub authorization state");
  try {
    const token = await tokenRequest({ code, redirect_uri: callbackUrl(), code_verifier: auth.codeVerifier });
    const me = await githubFetch(token.access_token!, "/user");
    const login = typeof me.login === "string" ? me.login : "account";
    await updateAuth(connectionId, (old) => ({ ...old, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined, tokenType: token.token_type ?? "bearer", state: undefined, stateExpiresAt: undefined, codeVerifier: undefined }));
    await db.update(mcpConnections).set({ label: `GitHub (@${login})`, status: "connected", lastError: null, reauthNotified: false, connectedAt: new Date() }).where(eq(mcpConnections.id, connectionId));
    return { connectionId, label: `GitHub (@${login})` };
  } catch (e) {
    await db.update(mcpConnections).set({ status: "error", lastError: "GitHub authorization failed. Try connecting again." }).where(eq(mcpConnections.id, connectionId));
    throw e;
  }
}

async function freshToken(connectionId: string): Promise<string> {
  const auth = await readAuth(connectionId);
  if (!auth.accessToken) throw new McpReauthRequired(connectionId);
  if (!auth.expiresAt || auth.expiresAt > Date.now() + 60_000) return auth.accessToken;
  if (!auth.refreshToken) throw new McpReauthRequired(connectionId);
  try {
    const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
    await updateAuth(connectionId, (old) => ({ ...old, accessToken: token.access_token, refreshToken: token.refresh_token ?? old.refreshToken, expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined, tokenType: token.token_type ?? old.tokenType }));
    return token.access_token!;
  } catch {
    throw new McpReauthRequired(connectionId);
  }
}

async function githubFetch(accessToken: string, path: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "x-github-api-version": "2022-11-28", "user-agent": "company-brain" } });
  if (r.status === 401) throw new McpReauthRequired("github");
  if (!r.ok) throw new Error(`GitHub request failed (${r.status})`);
  return r.json();
}
const segment = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return encodeURIComponent(v.trim());
};
const positive = (v: unknown, fallback = 30) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100 ? v : fallback;
const page = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 1;
const query = (p: Record<string, string | number | undefined>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v !== undefined) u.set(k, String(v)); return u.toString() ? `?${u}` : ""; };
const next = (items: unknown[], currentPage: number, size: number) => items.length === size ? currentPage + 1 : null;
const repoDetail = (r: any) => ({ full_name: r.full_name, private: r.private, description: r.description, default_branch: r.default_branch, visibility: r.visibility, language: r.language, topics: r.topics, updated_at: r.updated_at, html_url: r.html_url });
const issueSummary = (r: any) => ({ number: r.number, title: r.title, state: r.state, author: r.user?.login, updated_at: r.updated_at, html_url: r.html_url, pull_request: !!r.pull_request });
const pullSummary = (r: any) => ({ number: r.number, title: r.title, state: r.state, author: r.user?.login, draft: r.draft, updated_at: r.updated_at, html_url: r.html_url });

const TOOLS: McpToolInfo[] = [
  { name: "whoami", description: "Get the connected GitHub account.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_repositories", description: "List repositories accessible to the connected GitHub account.", inputSchema: { type: "object", properties: { page: { type: "number" }, per_page: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { name: "get_repository", description: "Get a GitHub repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] }, annotations: { readOnlyHint: true } },
  { name: "get_file", description: "Read a text file from a GitHub repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["owner", "repo", "path"] }, annotations: { readOnlyHint: true } },
  { name: "list_issues", description: "List issues in a GitHub repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] }, annotations: { readOnlyHint: true } },
  { name: "get_issue", description: "Get a GitHub issue.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" } }, required: ["owner", "repo", "issue_number"] }, annotations: { readOnlyHint: true } },
  { name: "list_pull_requests", description: "List pull requests in a GitHub repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] }, page: { type: "number" }, per_page: { type: "number" } }, required: ["owner", "repo"] }, annotations: { readOnlyHint: true } },
  { name: "get_pull_request", description: "Get a GitHub pull request.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["owner", "repo", "pull_number"] }, annotations: { readOnlyHint: true } },
];

/** A small native read-only GitHub adapter exposed through the existing MCP tool pipeline. */
export async function githubTools(): Promise<McpToolInfo[]> { configured(); return TOOLS; }
export async function githubCall(conn: ConnectionRow, name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = await freshToken(conn.id);
  const owner = () => segment(args.owner, "owner"); const repo = () => segment(args.repo, "repo");
  switch (name) {
    case "whoami": return githubFetch(token, "/user");
    case "list_repositories": { const currentPage = page(args.page); const size = positive(args.per_page, 20); const repos = await githubFetch(token, `/user/repos${query({ affiliation: "owner,collaborator,organization_member", sort: "updated", page: currentPage, per_page: size })}`) as any[]; return { page: currentPage, repositories: repos.map((r) => r.full_name).filter((r): r is string => typeof r === "string"), next_page: next(repos, currentPage, size) }; }
    case "get_repository": return repoDetail(await githubFetch(token, `/repos/${owner()}/${repo()}`));
    case "get_file": { const path = segment(args.path, "path").replace(/%2F/g, "/"); const file = await githubFetch(token, `/repos/${owner()}/${repo()}/contents/${path}${query({ ref: typeof args.ref === "string" ? args.ref : undefined })}`); if (file.type !== "file") throw new Error("path is not a file"); return { name: file.name, path: file.path, sha: file.sha, size: file.size, content: typeof file.content === "string" ? Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8") : null }; }
    case "list_issues": { const currentPage = page(args.page); const size = positive(args.per_page, 10); const issues = await githubFetch(token, `/repos/${owner()}/${repo()}/issues${query({ state: args.state === "closed" || args.state === "all" ? args.state : "open", page: currentPage, per_page: size })}`) as any[]; return { page: currentPage, issues: issues.map(issueSummary), next_page: next(issues, currentPage, size) }; }
    case "get_issue": { const issue = await githubFetch(token, `/repos/${owner()}/${repo()}/issues/${segment(args.issue_number, "issue_number")}`); return { ...issueSummary(issue), body: issue.body }; }
    case "list_pull_requests": { const currentPage = page(args.page); const size = positive(args.per_page, 10); const pulls = await githubFetch(token, `/repos/${owner()}/${repo()}/pulls${query({ state: args.state === "closed" || args.state === "all" ? args.state : "open", page: currentPage, per_page: size })}`) as any[]; return { page: currentPage, pull_requests: pulls.map(pullSummary), next_page: next(pulls, currentPage, size) }; }
    case "get_pull_request": { const pull = await githubFetch(token, `/repos/${owner()}/${repo()}/pulls/${segment(args.pull_number, "pull_number")}`); return { ...pullSummary(pull), body: pull.body, base: pull.base?.ref, head: pull.head?.ref }; }
    default: throw new Error(`unknown GitHub tool: ${name}`);
  }
}

export async function githubSession(conn: ConnectionRow): Promise<McpSession> {
  return {
    // Health checks use listTools, so verify the token against GitHub here instead of
    // reporting a dead/revoked account as healthy merely because the local schema exists.
    listTools: async () => { const token = await freshToken(conn.id); await githubFetch(token, "/user"); return githubTools(); },
    // The shared MCP pipeline serializes structuredContent. Wrap native REST
    // responses in that shape so arrays (such as repository listings) are not
    // mistaken for an empty MCP response.
    callTool: async (name, args) => ({ structuredContent: await githubCall(conn, name, args) }),
    close: async () => {},
  };
}
