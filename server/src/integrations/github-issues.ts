import { call, describe, IntegrationError, openToken, readIntegration, sealToken, writeIntegration, type Created, type PushPayload } from "./types";

let base = "https://api.github.com";
/** Tests only: points the client at a fake GitHub server. */
export const setGithubBaseForTest = (url: string | null) => { base = url ?? "https://api.github.com"; };

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export type GithubSettings = { token: string; repo: string; assigneeMap: Record<string, string>; labels: string[] };
type Stored = Omit<GithubSettings, "token"> & { tokenEnc?: string };

export async function getGithub(): Promise<GithubSettings | null> {
  const s = await readIntegration<Stored>("github-issues");
  if (!s?.tokenEnc) return null;
  return { repo: s.repo, assigneeMap: s.assigneeMap ?? {}, labels: s.labels ?? [], token: openToken(s.tokenEnc) };
}

export async function githubPublic() {
  const s = await readIntegration<Stored>("github-issues");
  return { configured: !!s?.tokenEnc && !!s.repo, repo: s?.repo ?? "", assigneeMap: s?.assigneeMap ?? {}, labels: s?.labels ?? ["pixel"] };
}

/** token omitted = keep the stored one. */
export async function saveGithub(b: { token?: string; repo: string; assigneeMap: Record<string, string>; labels: string[] }): Promise<void> {
  if (!REPO_RE.test(b.repo)) throw new IntegrationError("invalid", "Repository must look like owner/name");
  const old = await readIntegration<Stored>("github-issues");
  await writeIntegration("github-issues", { repo: b.repo, assigneeMap: b.assigneeMap, labels: b.labels, ...(b.token ? { tokenEnc: sealToken(b.token) } : old?.tokenEnc ? { tokenEnc: old.tokenEnc } : {}) } satisfies Stored);
}

const need = async (): Promise<GithubSettings> => {
  const s = await getGithub();
  if (!s?.repo) throw new IntegrationError("not_configured", "GitHub Issues is not configured: an admin must add a repository and token under Integrations > Task boards");
  return s;
};
const gh = (s: { token: string }, path: string, init: RequestInit = {}) =>
  call("GitHub", base, path, { ...init, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "company-brain", authorization: `Bearer ${s.token}`, ...(init.body ? { "content-type": "application/json" } : {}) } });

export async function createIssue(p: PushPayload, s?: GithubSettings): Promise<Created> {
  const cfg = s ?? (await need());
  if (!REPO_RE.test(cfg.repo)) throw new IntegrationError("invalid", "Repository must look like owner/name");
  const due = p.due?.toISOString().slice(0, 10);
  const assignee = p.ownerId ? cfg.assigneeMap[p.ownerId] : undefined;
  const body = describe(p, [...(due ? [`Due: ${due}`] : []), `Owner: ${p.ownerName ?? "unassigned"}`]);
  const issue = (await gh(cfg, `/repos/${cfg.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: p.title.slice(0, 256), body: body.slice(0, 60_000), labels: [...cfg.labels, ...(due ? [`due:${due}`] : [])], ...(assignee ? { assignees: [assignee] } : {}) }),
  })) as { number?: number; html_url?: string } | null;
  if (!issue?.html_url) throw new IntegrationError("upstream", "GitHub returned no issue");
  return { id: String(issue.number), url: issue.html_url };
}

/** Credential + repository check; creates nothing. */
export async function testGithub(s?: { token: string; repo: string }): Promise<{ repo: string }> {
  const cfg = s ?? (await need());
  if (!REPO_RE.test(cfg.repo)) throw new IntegrationError("invalid", "Repository must look like owner/name");
  const r = (await gh(cfg, `/repos/${cfg.repo}`)) as { full_name?: string; has_issues?: boolean } | null;
  if (r?.has_issues === false) throw new IntegrationError("invalid", "Issues are disabled on that repository");
  return { repo: r?.full_name ?? cfg.repo };
}
