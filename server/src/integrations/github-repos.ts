import { db } from "../db";
import { users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { gh, ghx, type Cred } from "./github-api";
import { githubCredential, installationCreds } from "./github-auth";
import { failure } from "./github-api";
import { IntegrationError, readIntegration, openToken } from "./types";

export type Repo = { fullName: string; private: boolean; hasIssues: boolean };
const PAGES = 5; // ponytail: the picker sees the first 500 repos the credential can access; type owner/name in the search box beyond that
const PER = 100;

const toRepo = (r: { full_name?: string; private?: boolean; has_issues?: boolean }): Repo => ({ fullName: r.full_name ?? "", private: !!r.private, hasIssues: r.has_issues !== false });

/** Repos one credential can access: an installation lists its own (/installation/repositories), a token lists /user/repos. */
async function reposOf(c: Cred): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const r = await ghx(c.token, "GET", c.kind === "app" ? "/installation/repositories" : "/user/repos", undefined, { per_page: String(PER), page: String(page), ...(c.kind === "pat" ? { sort: "pushed" } : {}) });
    if (r.status !== 200) throw failure(r, c.kind, "Metadata: Read");
    const list = (c.kind === "app" ? r.data?.repositories : r.data) as { full_name?: string }[] | undefined;
    out.push(...(list ?? []).map(toRepo));
    if ((list?.length ?? 0) < PER) break;
  }
  return out;
}

/** Search + pagination over every repo the connection can reach. `pat` lets the admin list with a token typed but not yet saved. */
export async function listRepos(o: { q?: string; page?: number; size?: number; pat?: string }): Promise<{ credential: "app" | "pat" | null; total: number; repos: Repo[]; page: number; hasMore: boolean }> {
  const stored = await readIntegration<{ tokenEnc?: string; preferPat?: boolean }>("github-issues");
  const creds: Cred[] = o.pat ? [{ token: o.pat, kind: "pat" }]
    : stored?.preferPat && stored.tokenEnc ? [{ token: openToken(stored.tokenEnc), kind: "pat" }]
    : await installationCreds();
  if (!creds.length && !o.pat && stored?.tokenEnc) creds.push({ token: openToken(stored.tokenEnc), kind: "pat" });
  if (!creds.length) throw new IntegrationError("not_configured", "No GitHub connection yet: connect the GitHub App under Sync, or paste a personal access token");
  const all = new Map<string, Repo>();
  let lastErr: unknown = null;
  for (const c of creds) {
    try { for (const r of await reposOf(c)) all.set(r.fullName, r); } catch (e) { lastErr = e; }
  }
  if (!all.size && lastErr) throw lastErr;
  const q = (o.q ?? "").trim().toLowerCase();
  const rows = [...all.values()].filter((r) => r.fullName && (!q || r.fullName.toLowerCase().includes(q))).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const size = Math.min(Math.max(o.size ?? 30, 1), 100), page = Math.max(o.page ?? 1, 1);
  return { credential: creds[0]!.kind, total: rows.length, repos: rows.slice((page - 1) * size, page * size), page, hasMore: rows.length > page * size };
}

/** Who may be assigned in the repo, via the credential that can see it. Collaborators first (needs push access), else /assignees (needs only Issues: read). */
export async function assignable(repo: string, pat?: string): Promise<{ login: string }[]> {
  const cred = pat ? { token: pat, kind: "pat" as const } : await githubCredential(repo);
  if (!cred) throw new IntegrationError("not_configured", "No GitHub connection yet");
  const pull = async (path: string) => {
    const out: { login: string }[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = (await gh(cred, "GET", path, undefined, { per_page: "100", page: String(page) })) as { login?: string }[] | null;
      out.push(...(list ?? []).filter((u) => u.login).map((u) => ({ login: u.login! })));
      if ((list?.length ?? 0) < 100) break;
    }
    return out;
  };
  try { return await pull(`/repos/${repo}/collaborators`); }
  catch (e) { if (e instanceof IntegrationError && (e.code === "unauthorized" || e.code === "not_found")) return pull(`/repos/${repo}/assignees`); throw e; }
}

export const activeUsers = () => db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.isBot, false), eq(users.deactivated, false)));
