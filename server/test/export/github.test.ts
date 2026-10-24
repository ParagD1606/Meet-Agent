import "../slack/env";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../../src/config";
import { decrypt, encrypt } from "../../src/crypto";
import { commitments, integrationPushes, settings, syncSources, users } from "../../src/db/schema";
import { clearProjectCache } from "../../src/integrations/github-projects";
import { githubTaskChanged, reconcileGithub } from "../../src/integrations/github-reconcile";
import { matchOwners } from "../../src/integrations/github-suggest";
import { setGithubBaseForTest } from "../../src/integrations/github-issues";
import { addCommitment } from "../../src/manager";
import { changeTask } from "../../src/manager/task-sync";
import { setMemoryLlm } from "../../src/memory/llm";
import { setGithubAppApiForTest } from "../../src/sync/providers/github";
import { installFakes, removeFakes } from "../memory/helpers";
import { call, db, login, resetDb } from "../api/helpers";

type Req = { method: string; path: string; query: Record<string, string>; body: any; auth: string | null };
/** A fake GitHub (REST + GraphQL + App endpoints). `reply` overrides any request; `issues` is the live issue state. */
function fake() {
  const reqs: Req[] = [];
  const s = {
    reqs, reply: null as null | ((r: Req) => Response | null), n: 0, mints: 0,
    issues: new Map<number, { state: string; state_reason?: string | null; closed_by?: { login: string } | null }>(),
    collaborators: "forbidden" as "forbidden" | "ok", appPerms: { issues: "write", metadata: "read" } as Record<string, string>,
    gql: null as null | ((q: string, v: any) => any),
    server: Bun.serve({
      port: 0,
      async fetch(req): Promise<Response> {
        const u = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        const r: Req = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: req.headers.get("authorization") };
        reqs.push(r);
        const custom = s.reply?.(r);
        if (custom) return custom;
        const p = u.pathname;
        if (/^\/app\/installations\/\d+\/access_tokens$/.test(p)) return Response.json({ token: `ghs_INSTALL_${++s.mints}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
        if (/^\/app\/installations\/\d+$/.test(p)) return Response.json({ permissions: s.appPerms });
        if (p === "/installation/repositories") {
          const all = Array.from({ length: 130 }, (_, i) => ({ full_name: `acme/repo-${String(i).padStart(3, "0")}`, private: i % 2 === 0, has_issues: true }));
          const page = Number(u.searchParams.get("page") ?? 1);
          return Response.json({ total_count: 130, repositories: all.slice((page - 1) * 100, page * 100).concat(page === 1 ? [{ full_name: "acme/web", private: true, has_issues: true }] : []) });
        }
        if (p === "/user/repos") return Response.json([{ full_name: "me/pat-repo", private: false, has_issues: true }]);
        if (p === "/repos/acme/web") return Response.json({ full_name: "acme/web", has_issues: true }, { headers: { "x-oauth-scopes": "repo, read:org" } });
        if (p === "/repos/acme/web/collaborators") return s.collaborators === "ok" ? Response.json([{ login: "bobgh" }, { login: "carol" }]) : Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
        if (p === "/repos/acme/web/assignees") return Response.json([{ login: "bobgh" }, { login: "carol" }, { login: "dave-d" }]);
        const usr = p.match(/^\/users\/(.+)$/);
        if (usr) return Response.json({ login: usr[1], name: usr[1] === "carol" ? "Carol Danvers" : null, email: usr[1] === "bobgh" ? "bob@acme.test" : null });
        if (p === "/repos/acme/web/issues" && req.method === "POST") { const n = ++s.n; s.issues.set(n, { state: "open" }); return Response.json({ number: n, node_id: `I_${n}`, html_url: `https://github.com/acme/web/issues/${n}` }, { status: 201 }); }
        if (p === "/repos/acme/web/issues") return Response.json([]);
        const one = p.match(/^\/repos\/acme\/web\/issues\/(\d+)$/);
        if (one) {
          const st = s.issues.get(Number(one[1]));
          if (!st) return new Response("{}", { status: 404 });
          if (req.method === "PATCH") { Object.assign(st, { state: body.state, state_reason: body.state_reason ?? null }); return Response.json({ number: Number(one[1]), ...st }); }
          return Response.json({ number: Number(one[1]), ...st });
        }
        if (/^\/repos\/acme\/web\/issues\/\d+\/comments$/.test(p)) return Response.json({ id: 1 }, { status: 201 });
        if (p === "/graphql") {
          const q: string = body.query;
          const out = s.gql?.(q, body.variables);
          if (out) return Response.json(out);
          if (q.includes("addProjectV2ItemById")) return Response.json({ data: { addProjectV2ItemById: { item: { id: "PVTI_1" } } } });
          if (q.includes("updateProjectV2ItemFieldValue")) return Response.json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } });
          return Response.json({ data: { repositoryOwner: { projectV2: { id: "PVT_1", title: "Roadmap", fields: { nodes: [{ id: "F_title", name: "Title", dataType: "TITLE" }, { id: "F_due", name: "Due", dataType: "DATE" }, { id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "O_todo", name: "Todo" }, { id: "O_done", name: "Done" }] }] } } } } });
        }
        return new Response("{}", { status: 404 });
      },
    }),
  };
  return Object.assign(s, { url: `http://localhost:${s.server.port}`, posts: (path?: string) => reqs.filter((r) => r.method === "POST" && (!path || r.path === path)) });
}

let gh: ReturnType<typeof fake>;
let admin: string, bob: string;
const PAT = "ghp_SECRETPAT0123456789";
const logs: string[] = [];
const origLog = [console.log, console.info, console.warn, console.error];
const saved = { id: config.GITHUB_APP_ID, slug: config.GITHUB_APP_SLUG, key: config.GITHUB_APP_PRIVATE_KEY };

beforeAll(() => {
  installFakes();
  gh = fake();
  setGithubBaseForTest(gh.url); setGithubAppApiForTest(gh.url);
  config.GITHUB_APP_ID = "123"; config.GITHUB_APP_SLUG = "pixel-app";
  config.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (const k of ["log", "info", "warn", "error"] as const) console[k] = ((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as never;
});
afterAll(() => {
  removeFakes(); gh.server.stop(true); setGithubBaseForTest(null); setGithubAppApiForTest(null);
  Object.assign(config, { GITHUB_APP_ID: saved.id, GITHUB_APP_SLUG: saved.slug, GITHUB_APP_PRIVATE_KEY: saved.key });
  [console.log, console.info, console.warn, console.error] = origLog;
});

const mk = (o: Partial<Parameters<typeof addCommitment>[0]> & { text: string; sourceRef: string }) =>
  addCommitment({ sourceType: "message", scopeTag: "shared", channelId: "C1", ownerId: "UBOB", ownerName: "User UBOB", assignerId: "UALICE", permalink: "https://slack.example/p/1", ...o });
const taskId = async (ref: string) => (await db.select().from(commitments).where(eq(commitments.sourceRef, ref)))[0]!.id;
const push = async (id: string) => (await (await call("POST", `/api/tasks/${id}/push`, { cookie: admin, body: { target: "github" } })).json()) as any;
const put = (extra: object = {}) => call("PUT", "/api/settings/integrations/github-issues", { cookie: admin, body: { repo: "acme/web", assigneeMap: { UBOB: "bobgh" }, labels: ["pixel"], ...extra } });
/** A sync_sources row for a connected GitHub App installation; `expired` makes the stored token stale. */
const installation = (o: { expired?: boolean; id?: string } = {}) => db.insert(syncSources).values({ id: `sync_${o.id ?? "1"}`, provider: "github", authEnc: encrypt(JSON.stringify({ accessToken: "ghs_OLD", expiresAt: o.expired ? Date.now() - 1000 : Date.now() + 3600_000, extra: { installationId: o.id ?? "99" } })) });

beforeEach(async () => {
  await resetDb();
  setMemoryLlm(async () => '{"superseded":[]}');
  gh.reqs.length = 0; gh.reply = null; gh.n = 0; gh.mints = 0; gh.issues.clear(); gh.gql = null; gh.collaborators = "forbidden"; gh.appPerms = { issues: "write", metadata: "read" };
  clearProjectCache(); logs.length = 0;
  admin = await login("UADMIN", "admin"); bob = await login("UBOB", "member");
});

describe("credential: GitHub App installation first, token as fallback", () => {
  test("a stale installation token is re-minted, persisted encrypted and used for the issue; the PAT is not asked for", async () => {
    await installation({ expired: true });
    expect((await put()).status).toBe(200); // no token in the body
    const pub = await (await call("GET", "/api/settings/integrations/github-issues", { cookie: admin })).json() as any;
    expect(pub).toMatchObject({ configured: true, credential: { kind: "app", installations: 1, hasPat: false, appSlug: "pixel-app" } });
    await mk({ text: "Via app", sourceRef: "a1" });
    const r = await push(await taskId("a1"));
    expect(r.result.status).toBe("created");
    expect(gh.mints).toBe(1);
    expect(gh.posts("/repos/acme/web/issues")[0]!.auth).toBe("Bearer ghs_INSTALL_1");
    const [row] = await db.select().from(syncSources);
    expect(JSON.parse(decrypt(row!.authEnc!)).accessToken).toBe("ghs_INSTALL_1");
    // fresh now: a second push mints nothing
    await mk({ text: "Again", sourceRef: "a2" });
    await push(await taskId("a2"));
    expect(gh.mints).toBe(1);
    expect(JSON.stringify(pub)).not.toContain("ghs_");
  });
  test("no installation -> the stored PAT; preferPat overrides an installation", async () => {
    await put({ token: PAT });
    await mk({ text: "Pat", sourceRef: "p1" });
    await push(await taskId("p1"));
    expect(gh.posts("/repos/acme/web/issues")[0]!.auth).toBe(`Bearer ${PAT}`);
    await installation();
    await put({ usePat: false });
    await mk({ text: "App", sourceRef: "p2" });
    await push(await taskId("p2"));
    expect(gh.posts("/repos/acme/web/issues")[1]!.auth).toBe("Bearer ghs_OLD");
    await put({ usePat: true });
    await mk({ text: "Override", sourceRef: "p3" });
    await push(await taskId("p3"));
    expect(gh.posts("/repos/acme/web/issues")[2]!.auth).toBe(`Bearer ${PAT}`);
    const [row] = await db.select().from(settings).where(eq(settings.key, "integration:github-issues"));
    expect(JSON.stringify(row!.value)).not.toContain(PAT);
  });
  test("nothing connected -> not configured (409)", async () => {
    await put();
    await mk({ text: "Nowhere", sourceRef: "n1" });
    expect((await call("POST", `/api/tasks/${await taskId("n1")}/push`, { cookie: admin, body: { target: "github" } })).status).toBe(409);
    expect(await (await call("GET", "/api/integrations/targets", { cookie: bob })).json()).toEqual({ trello: false, github: false });
  });
});

describe("repo picker", () => {
  test("installation repositories: paginated, searchable, admin only", async () => {
    await installation();
    const p1 = await (await call("GET", "/api/integrations/github/repos?size=50", { cookie: admin })).json() as any;
    expect(p1).toMatchObject({ credential: "app", total: 131, page: 1, hasMore: true });
    expect(p1.repos).toHaveLength(50);
    const p3 = await (await call("GET", "/api/integrations/github/repos?size=50&page=3", { cookie: admin })).json() as any;
    expect(p3.repos).toHaveLength(31);
    expect(p3.hasMore).toBe(false);
    const q = await (await call("GET", "/api/integrations/github/repos?q=WEB", { cookie: admin })).json() as any;
    expect(q.repos).toEqual([{ fullName: "acme/web", private: true, hasIssues: true }]);
    expect(gh.reqs.some((r) => r.path === "/installation/repositories" && r.auth === "Bearer ghs_OLD")).toBe(true);
    expect((await call("GET", "/api/integrations/github/repos", { cookie: bob })).status).toBe(403);
  });
  test("token: /user/repos; nothing connected: clear 409", async () => {
    expect((await call("GET", "/api/integrations/github/repos", { cookie: admin })).status).toBe(409);
    await put({ token: PAT });
    const r = await (await call("GET", "/api/integrations/github/repos", { cookie: admin })).json() as any;
    expect(r).toMatchObject({ credential: "pat", repos: [{ fullName: "me/pat-repo" }] });
  });
});

describe("Test button", () => {
  test("all good: lists the checks, creates nothing", async () => {
    await installation(); await put();
    const t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: {} })).json() as any;
    expect(t).toMatchObject({ ok: true, credential: "app" });
    expect(t.checks.map((c: any) => c.name)).toEqual(["credential", "repository", "issues enabled", "issues access", "app permissions"]);
    expect(gh.posts("/repos/acme/web/issues")).toHaveLength(0);
  });
  test("missing app permission names exactly what to add and where", async () => {
    await installation(); await put();
    gh.appPerms = { issues: "read", metadata: "read" };
    const t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: {} })).json() as any;
    expect(t.ok).toBe(false);
    expect(t.message).toContain("Issues: Read & write");
    expect(t.message).toContain("https://github.com/settings/apps/pixel-app/permissions");
    expect(t.message).toContain("organization owner must approve");
  });
  test("403 'Resource not accessible by integration' on the repo -> permission hint; 404 -> add the repo to the installation", async () => {
    await installation(); await put();
    gh.reply = (r) => (r.path === "/repos/acme/web/issues" ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 }) : null);
    let t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: {} })).json() as any;
    expect(t.message).toContain("Issues: Read & write");
    gh.reply = (r) => (r.path === "/repos/acme/web" ? new Response("{}", { status: 404 }) : null);
    t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: {} })).json() as any;
    expect(t.message).toContain("add the repository to the app installation");
  });
  test("classic token without the repo scope is reported; project problems are reported separately", async () => {
    gh.reply = (r) => (r.path === "/repos/acme/web" ? Response.json({ full_name: "acme/web", has_issues: true }, { headers: { "x-oauth-scopes": "read:user" } }) : null);
    let t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: { repo: "acme/web", token: PAT } })).json() as any;
    expect(t.message).toContain("`repo` scope");
    gh.reply = null;
    gh.gql = () => ({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:project" }] });
    t = await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: { repo: "acme/web", token: PAT, projectOwner: "acme", projectNumber: 3 } })).json() as any;
    expect(t.checks.at(-1)).toMatchObject({ name: "project", ok: false });
    expect(t.message).toContain("`project` scope");
    expect(JSON.stringify(t)).not.toContain(PAT);
  });
});

describe("owner mapping suggestions", () => {
  const people = [
    { id: "U1", name: "Bob Builder", email: "bob@acme.test" }, { id: "U2", name: "Caro Líne", email: "c.line@acme.test" },
    { id: "U3", name: "Carol Danvers", email: "cd@acme.test" }, { id: "U4", name: "Dave D", email: "dave-d@acme.test" }, { id: "U5", name: "Eve Twin", email: null }, { id: "U6", name: "Eve Twin", email: null },
  ];
  test("exact email, then login == email name, then normalised full name; ambiguity is never guessed", () => {
    const s = matchOwners(people, [
      { login: "bobgh", email: "BOB@acme.test" }, { login: "dave-d" }, { login: "carolx", name: "carol  DANVERS" }, { login: "caroline", name: "Caro Line" }, { login: "eve", name: "Eve Twin" },
    ]);
    const by = Object.fromEntries(s.map((x) => [x.userId, x]));
    expect(by.U1).toMatchObject({ login: "bobgh", confidence: "high" });
    expect(by.U4).toMatchObject({ login: "dave-d", confidence: "medium" });
    expect(by.U3).toMatchObject({ login: "carolx", confidence: "low" });
    expect(by.U2).toMatchObject({ login: "caroline", confidence: "low" }); // accents normalised
    expect(by.U5 ?? by.U6).toBeUndefined(); // two people called Eve Twin
  });
  test("endpoint: falls back to /assignees when collaborators are not accessible; no emails leak", async () => {
    await installation(); await put();
    await db.update(users).set({ email: "bob@acme.test" }).where(eq(users.id, "UBOB"));
    const r = await (await call("GET", "/api/integrations/github/suggestions?repo=acme/web", { cookie: admin })).json() as any;
    expect(gh.reqs.some((x) => x.path === "/repos/acme/web/collaborators")).toBe(true);
    expect(gh.reqs.some((x) => x.path === "/repos/acme/web/assignees")).toBe(true);
    expect(r.candidates.map((c: any) => c.login)).toEqual(["bobgh", "carol", "dave-d"]);
    expect(r.suggestions).toEqual([{ userId: "UBOB", userName: "User UBOB", login: "bobgh", confidence: "high", reason: "same email" }]);
    expect(JSON.stringify(r)).not.toContain("@acme.test");
    gh.collaborators = "ok"; gh.reqs.length = 0;
    await call("GET", "/api/integrations/github/suggestions?repo=acme/web", { cookie: admin });
    expect(gh.reqs.some((x) => x.path === "/repos/acme/web/assignees")).toBe(false);
  });
});

describe("issue payload", () => {
  test("labels, assignee, milestone, marker, body parts", async () => {
    await put({ token: PAT, milestone: 7, labels: ["pixel", "team"] });
    await mk({ text: "Ship it", sourceRef: "i1", dueAt: new Date("2026-11-02T09:00:00Z"), priority: "urgent" });
    const id = await taskId("i1");
    await push(id);
    const b = gh.posts("/repos/acme/web/issues")[0]!.body;
    expect(b).toMatchObject({ title: "Ship it", labels: ["pixel", "team", "due:2026-11-02", "priority:urgent"], assignees: ["bobgh"], milestone: 7 });
    expect(b.body).toContain("Due: 2026-11-02");
    expect(b.body).toContain("Owner: User UBOB");
    expect(b.body).toContain("Source: https://slack.example/p/1");
    expect(b.body).toContain("Created by Pixel");
    expect(b.body).toContain(`<!-- pixel-task:${id} -->`);
    const [a] = await db.select().from(integrationPushes);
    expect(a).toMatchObject({ status: "ok", lastState: "open" });
  });
});

describe("GitHub Project (v2)", () => {
  const withProject = () => put({ token: PAT, projectOwner: "acme", projectNumber: 3 });
  test("adds the issue to the project and sets Due and Status=Todo; project metadata is cached", async () => {
    await withProject();
    await mk({ text: "On board", sourceRef: "pj1", dueAt: new Date("2026-11-02T09:00:00Z") });
    await mk({ text: "On board 2", sourceRef: "pj2" });
    const r = await push(await taskId("pj1"));
    expect(r.result).toMatchObject({ status: "created" });
    expect(r.result.warning).toBeUndefined();
    const g = gh.posts("/graphql").map((x) => x.body);
    expect(g.find((x) => x.query.includes("addProjectV2ItemById"))!.variables).toEqual({ project: "PVT_1", content: "I_1" });
    const sets = g.filter((x) => x.query.includes("updateProjectV2ItemFieldValue")).map((x) => [x.variables.field, x.variables.value]);
    expect(sets).toEqual([["F_due", { date: "2026-11-02" }], ["F_status", { singleSelectOptionId: "O_todo" }]]);
    await push(await taskId("pj2"));
    expect(gh.posts("/graphql").filter((x) => x.body.query.includes("projectV2(number")).length).toBe(1);
  });
  test("a failing project step never fails the issue: the result and audit row say what to fix", async () => {
    await withProject();
    gh.gql = () => ({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] });
    await mk({ text: "No scope", sourceRef: "pj3" });
    const res = await call("POST", `/api/tasks/${await taskId("pj3")}/push`, { cookie: admin, body: { target: "github" } });
    expect(res.status).toBe(200);
    const r = await res.json() as any;
    expect(r.result).toMatchObject({ status: "created", url: "https://github.com/acme/web/issues/1" });
    expect(r.result.warning).toContain("issue created, project step failed:");
    expect(r.result.warning).toContain("`project` scope");
    const [row] = await db.select().from(integrationPushes);
    expect(row).toMatchObject({ status: "ok", externalId: "1" });
    expect(row!.error).toContain("project step failed");
    // idempotent: no second issue
    expect((await push(await taskId("pj3"))).result.status).toBe("existing");
    expect(gh.posts("/repos/acme/web/issues")).toHaveLength(1);
  });
  test("an app installation gets the Organization projects permission hint", async () => {
    await installation(); await put({ projectOwner: "acme", projectNumber: 3 });
    gh.gql = () => ({ errors: [{ message: "Resource not accessible by integration" }] });
    await mk({ text: "App project", sourceRef: "pj4" });
    const r = await push(await taskId("pj4"));
    expect(r.result.warning).toContain("Organization projects: Read & write");
    expect(r.result.warning).toContain("settings/apps/pixel-app/permissions");
  });
});

describe("reconcile (two-way status)", () => {
  const pushed = async (ref: string, extra: object = {}) => {
    await put({ token: PAT });
    await mk({ text: `Task ${ref}`, sourceRef: ref, ...extra });
    const id = await taskId(ref);
    await push(id);
    return id;
  };
  const patches = () => gh.reqs.filter((r) => r.method === "PATCH");
  const status = async (id: string) => (await db.select().from(commitments).where(eq(commitments.id, id)))[0]!.status;
  const last = async () => (await db.select().from(integrationPushes))[0]!.lastState;

  test("issue closed on GitHub -> task done; nothing is written back to GitHub (no loop)", async () => {
    const id = await pushed("r1");
    gh.issues.set(1, { state: "closed", state_reason: "completed", closed_by: { login: "bobgh" } });
    expect(await reconcileGithub()).toMatchObject({ checked: 1, taskClosed: 1 });
    expect(await status(id)).toBe("done");
    expect(await last()).toBe("closed");
    expect(await reconcileGithub()).toMatchObject({ taskClosed: 0, issuesClosed: 0 });
    expect(patches()).toHaveLength(0);
    await githubTaskChanged(id); // the immediate hook finds both sides closed
    expect(patches()).toHaveLength(0);
  });
  test("not_planned on GitHub -> task dropped", async () => {
    const id = await pushed("r2");
    gh.issues.set(1, { state: "closed", state_reason: "not_planned", closed_by: { login: "x" } });
    await reconcileGithub();
    expect(await status(id)).toBe("dropped");
  });
  test("task done in Pixel -> issue closed (completed) with a comment; second run is quiet; reopen both ways", async () => {
    const id = await pushed("r3");
    await changeTask(id, { status: "done" }, { id: "UBOB" });
    await Bun.sleep(150); // the immediate best-effort hook
    expect(gh.issues.get(1)).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(gh.posts("/repos/acme/web/issues/1/comments")[0]!.body.body).toBe("Marked done in Pixel");
    expect(await last()).toBe("closed");
    gh.reqs.length = 0;
    await reconcileGithub();
    expect(patches()).toHaveLength(0);
    // reopened in Pixel -> reopened on GitHub
    await changeTask(id, { status: "open" }, { id: "UBOB" });
    await Bun.sleep(150);
    expect(gh.issues.get(1)!.state).toBe("open");
    // reopened on GitHub after Pixel closed it -> task reopens
    await changeTask(id, { status: "done" }, { id: "UBOB" });
    await Bun.sleep(150);
    gh.issues.get(1)!.state = "open";
    await reconcileGithub();
    expect(await status(id)).toBe("open");
  });
  test("task dropped in Pixel -> closed as not_planned", async () => {
    const id = await pushed("r4");
    await changeTask(id, { status: "dropped" }, { id: "UBOB" });
    await Bun.sleep(150);
    expect(gh.issues.get(1)).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });
  test("429 stops the batch (Retry-After respected: no further calls); 401 stops; 404 is skipped", async () => {
    await pushed("r5");
    await mk({ text: "Second", sourceRef: "r6" });
    await push(await taskId("r6"));
    gh.reqs.length = 0;
    gh.reply = () => new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    expect(await reconcileGithub()).toMatchObject({ checked: 1, stopped: "rate limited" });
    expect(gh.reqs.filter((r) => r.path.startsWith("/repos/acme/web/issues/"))).toHaveLength(1);
    gh.reply = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    expect(await reconcileGithub()).toMatchObject({ stopped: "rate limited" });
    gh.reply = () => new Response("{}", { status: 401 });
    expect(await reconcileGithub()).toMatchObject({ stopped: "credentials rejected" });
    gh.reply = () => new Response("{}", { status: 404 });
    expect(await reconcileGithub()).toMatchObject({ checked: 2, skipped: 2 });
    gh.reply = null;
    const rows = await db.select().from(integrationPushes);
    expect(rows.every((r) => r.lastState === "open")).toBe(true);
  });
  test("a failed push has no issue to reconcile; secrets never reach logs", async () => {
    await put({ token: PAT });
    await mk({ text: "Fails", sourceRef: "r7" });
    gh.reply = (r) => (r.method === "POST" ? new Response("{}", { status: 403 }) : null);
    expect((await push(await taskId("r7"))).result.status).toBe("failed");
    expect(await reconcileGithub()).toMatchObject({ checked: 0 });
    expect(logs.join("\n") + JSON.stringify(await db.select().from(integrationPushes))).not.toContain(PAT);
  });
});
