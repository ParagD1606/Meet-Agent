import { config } from "../config";
import { appJwt, githubAppConfigured } from "../sync/providers/github";
import { credentialInfo, githubCredential } from "./github-auth";
import { failure, gh, ghx, type Cred } from "./github-api";
import { addToProject, projectMeta, type ProjectRef } from "./github-projects";
import { IntegrationError, readIntegration, sealToken, writeIntegration, type Created, type PushPayload } from "./types";

export { setGithubBaseForTest } from "./github-api";

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export type GithubSettings = { cred: Cred; repo: string; assigneeMap: Record<string, string>; labels: string[]; milestone?: number; project?: ProjectRef };
type Stored = { repo: string; assigneeMap: Record<string, string>; labels: string[]; milestone?: number; projectOwner?: string; projectNumber?: number; tokenEnc?: string; preferPat?: boolean };

const projectOf = (s: Stored | null): ProjectRef | undefined => (s?.projectOwner && s.projectNumber ? { owner: s.projectOwner, number: s.projectNumber } : undefined);

/** Settings plus the credential in use (GitHub App installation first, else the stored token). Null until a repo and some credential exist. */
export async function getGithub(): Promise<GithubSettings | null> {
  const s = await readIntegration<Stored>("github-issues");
  if (!s?.repo) return null;
  const cred = await githubCredential(s.repo);
  if (!cred) return null;
  return { cred, repo: s.repo, assigneeMap: s.assigneeMap ?? {}, labels: s.labels ?? [], milestone: s.milestone, project: projectOf(s) };
}

/** Cheap "can members send here?" check: a repo and a credential exist (no token is minted). */
export async function githubReady(): Promise<boolean> {
  const s = await readIntegration<Stored>("github-issues");
  return !!s?.repo && (await credentialInfo()).kind !== "none";
}

export async function githubPublic() {
  const s = await readIntegration<Stored>("github-issues");
  const info = await credentialInfo();
  return {
    configured: !!s?.repo && info.kind !== "none", repo: s?.repo ?? "", assigneeMap: s?.assigneeMap ?? {}, labels: s?.labels ?? ["pixel"],
    milestone: s?.milestone ?? null, projectOwner: s?.projectOwner ?? "", projectNumber: s?.projectNumber ?? null,
    credential: { ...info, appSlug: config.GITHUB_APP_SLUG ?? null },
  };
}

export type SaveGithub = { token?: string; usePat?: boolean; repo: string; assigneeMap: Record<string, string>; labels: string[]; milestone?: number | null; projectOwner?: string; projectNumber?: number | null };
/** token omitted = keep the stored one. A token saved while the app is connected is an explicit override unless usePat=false. */
export async function saveGithub(b: SaveGithub): Promise<void> {
  if (!REPO_RE.test(b.repo)) throw new IntegrationError("invalid", "Repository must look like owner/name");
  const old = await readIntegration<Stored>("github-issues");
  const tokenEnc = b.token ? sealToken(b.token) : old?.tokenEnc;
  const value: Stored = {
    repo: b.repo, assigneeMap: b.assigneeMap, labels: b.labels,
    ...(b.milestone ? { milestone: b.milestone } : {}),
    ...(b.projectOwner && b.projectNumber ? { projectOwner: b.projectOwner, projectNumber: b.projectNumber } : {}),
    ...(tokenEnc ? { tokenEnc } : {}),
    ...(tokenEnc && (b.usePat ?? (b.token ? true : old?.preferPat)) ? { preferPat: true } : {}),
  };
  await writeIntegration("github-issues", value);
}

const need = async (): Promise<GithubSettings> => {
  const s = await getGithub();
  if (!s) throw new IntegrationError("not_configured", "GitHub Issues is not configured: an admin must pick a repository and a GitHub connection under Integrations > Task boards");
  return s;
};

/** The issue body: description, Due, Owner, Source, evidence quote, footer and the hidden marker used to reconcile the issue with its task. */
export function issueBody(p: PushPayload, due?: string): string {
  return [
    p.description.trim(),
    due && `Due: ${due}`,
    `Owner: ${p.ownerName ?? "unassigned"}`,
    p.sourceUrl && `Source: ${p.sourceUrl}`,
    p.quote.trim() && `> ${p.quote.trim().replace(/\s*\n\s*/g, " ")}`,
    `Created by Pixel from ${p.origin}`,
    p.taskId && `<!-- pixel-task:${p.taskId} -->`,
  ].filter(Boolean).join("\n\n");
}

export async function createIssue(p: PushPayload, s?: GithubSettings): Promise<Created> {
  const cfg = s ?? (await need());
  if (!REPO_RE.test(cfg.repo)) throw new IntegrationError("invalid", "Repository must look like owner/name");
  const due = p.due?.toISOString().slice(0, 10);
  const assignee = p.ownerId ? cfg.assigneeMap[p.ownerId] : undefined;
  const issue = (await gh(cfg.cred, "POST", `/repos/${cfg.repo}/issues`, {
    title: p.title.slice(0, 256), body: issueBody(p, due).slice(0, 60_000),
    labels: [...cfg.labels, ...(due ? [`due:${due}`] : []), ...(p.urgent ? ["priority:urgent"] : [])],
    ...(assignee ? { assignees: [assignee] } : {}), ...(cfg.milestone ? { milestone: cfg.milestone } : {}),
  })) as { number?: number; html_url?: string; node_id?: string } | null;
  if (!issue?.html_url) throw new IntegrationError("upstream", "GitHub returned no issue");
  const made: Created = { id: String(issue.number), url: issue.html_url };
  if (cfg.project) {
    try {
      if (!issue.node_id) throw new IntegrationError("upstream", "GitHub returned no issue node id");
      await addToProject(cfg.cred, cfg.project, issue.node_id, due);
    } catch (e) {
      // never fails the issue: the push result says what to fix
      made.warning = `issue created, project step failed: ${e instanceof IntegrationError ? e.message : "unexpected error"}`;
    }
  }
  return made;
}

// ---------- Test button ----------
export type Check = { name: string; ok: boolean; message: string };
export type TestResult = { ok: boolean; repo: string; credential: "app" | "pat" | null; checks: Check[]; message?: string };

/** Installation permissions (needs the app JWT; only for app credentials). */
async function appPermissions(c: Cred): Promise<Record<string, string> | null> {
  if (c.kind !== "app" || !c.installationId || !githubAppConfigured()) return null;
  try {
    const r = await ghx(appJwt(), "GET", `/app/installations/${c.installationId}`);
    return r.status === 200 ? (r.data?.permissions ?? null) : null;
  } catch { return null; }
}

/** Credential, repository, issues enabled, permissions and (optionally) the project. Creates nothing. Only a rate limit throws. */
export async function testGithub(o: { repo: string; cred: Cred | null; project?: ProjectRef }): Promise<TestResult> {
  const checks: Check[] = [];
  const done = (): TestResult => ({ ok: checks.every((c) => c.ok), repo: o.repo, credential: o.cred?.kind ?? null, checks, message: checks.find((c) => !c.ok)?.message });
  const run = async (name: string, f: () => Promise<string>): Promise<boolean> => {
    try { checks.push({ name, ok: true, message: await f() }); return true; }
    catch (e) { if (e instanceof IntegrationError && e.code === "rate_limited") throw e; checks.push({ name, ok: false, message: e instanceof IntegrationError ? e.message : "Unexpected error" }); return false; }
  };
  if (!REPO_RE.test(o.repo)) { checks.push({ name: "repository", ok: false, message: "Repository must look like owner/name" }); return done(); }
  const cred = o.cred;
  if (!cred) { checks.push({ name: "credential", ok: false, message: "No GitHub connection: connect the GitHub App under Sync, or paste a personal access token" }); return done(); }
  checks.push({ name: "credential", ok: true, message: cred.kind === "app" ? "Using the GitHub App installed for sync" : "Using a personal access token" });

  let repoInfo: { full_name?: string; has_issues?: boolean } | null = null;
  let scopes: string | null = null;
  const repoOk = await run("repository", async () => {
    const r = await ghx(cred.token, "GET", `/repos/${o.repo}`);
    if (r.status < 200 || r.status >= 300) throw r.status === 404 ? new IntegrationError("not_found", `Repository ${o.repo} was not found, or this connection cannot see it${cred.kind === "app" ? ": add the repository to the app installation (GitHub > Settings > Applications > Configure > Repository access)" : ""}`) : failure(r, cred.kind, "Metadata: Read");
    repoInfo = r.data; scopes = r.headers.get("x-oauth-scopes");
    return `Found ${r.data?.full_name ?? o.repo}`;
  });
  if (!repoOk) return done();
  await run("issues enabled", async () => { if ((repoInfo as { has_issues?: boolean } | null)?.has_issues === false) throw new IntegrationError("invalid", "Issues are disabled on that repository (Settings > Features > Issues)"); return "Issues are enabled"; });
  await run("issues access", async () => {
    const r = await ghx(cred.token, "GET", `/repos/${o.repo}/issues`, undefined, { per_page: "1" });
    if (r.status !== 200) throw failure(r, cred.kind, "Issues: Read & write");
    if (cred.kind === "pat" && scopes !== null && scopes !== "" && !/\b(repo|public_repo)\b/.test(scopes)) throw new IntegrationError("unauthorized", `The classic token can read but lacks the \`repo\` scope (it has: ${scopes}); create issues needs \`repo\``);
    return "Issues can be read";
  });
  if (cred.kind === "app") await run("app permissions", async () => {
    const perm = await appPermissions(cred);
    if (!perm) return "Permissions could not be listed (the first push will tell)";
    const missing = [perm.issues !== "write" && "Issues: Read & write", !perm.metadata && "Metadata: Read", o.project && perm.organization_projects !== "write" && "Organization projects: Read & write"].filter(Boolean) as string[];
    if (missing.length) throw new IntegrationError("unauthorized", `The GitHub App is missing: ${missing.join(", ")}. Add it at https://github.com/settings/apps/${config.GITHUB_APP_SLUG ?? "<app-slug>"}/permissions (organization-owned app: the organization's Developer settings), then an organization owner must approve the updated permissions on the installation page`);
    return "Issues: Read & write";
  });
  if (o.project) await run("project", async () => {
    const m = await projectMeta(cred, o.project!);
    return `Project "${m.title}" found; Due date field: ${m.dueFieldId ? "yes" : "no (skipped)"}; Status 'Todo': ${m.todoOptionId ? "yes" : "no (skipped)"}`;
  });
  return done();
}
