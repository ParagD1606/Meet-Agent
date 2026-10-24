import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { channelMembers, channels, commitments, integrationPushes, meetings, settings } from "../../src/db/schema";
import { setMeetingSourceForTest, type MeetingItemRow } from "../../src/export/meeting-source";
import { setGithubBaseForTest } from "../../src/integrations/github-issues";
import { setTrelloBaseForTest } from "../../src/integrations/trello";
import { addCommitment } from "../../src/manager";
import { setMemoryLlm } from "../../src/memory/llm";
import { installFakes, removeFakes } from "../memory/helpers";
import { call, db, login, resetDb } from "../api/helpers";
import { validateIcs } from "./ics";

type Req = { method: string; path: string; query: Record<string, string>; body: any; headers: Headers };
/** A fake Trello / GitHub: records requests, answers with `reply` (override per test). */
function fake(kind: "trello" | "github") {
  const reqs: Req[] = [];
  const s: { reqs: Req[]; reply: null | ((r: Req) => Response | null); n: number; server: ReturnType<typeof Bun.serve> } = {
    reqs, reply: null, n: 0,
    server: Bun.serve({
      port: 0,
      async fetch(req): Promise<Response> {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.json().catch(() => null) : null;
        const r: Req = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: req.headers };
        reqs.push(r);
        const custom = s.reply?.(r);
        if (custom) return custom;
        const n = ++s.n;
        if (kind === "trello") {
          if (u.pathname === "/members/me") return Response.json({ username: "pixelbot" });
          if (u.pathname === "/members/me/boards") return Response.json([{ id: "b1", name: "Roadmap", extra: 1 }]);
          if (u.pathname === "/boards/b1/lists") return Response.json([{ id: "l1", name: "To do" }]);
          if (u.pathname === "/boards/b1/members") return Response.json([{ id: "m1", fullName: "Bob B", username: "bobb" }]);
          if (u.pathname === "/cards") return Response.json({ id: `card${n}`, shortUrl: `https://trello.com/c/card${n}` });
        } else {
          if (u.pathname === "/repos/acme/web") return Response.json({ full_name: "acme/web", has_issues: true });
          if (u.pathname === "/repos/acme/web/issues") return Response.json({ number: n, html_url: `https://github.com/acme/web/issues/${n}` });
        }
        return new Response("{}", { status: 404 });
      },
    }),
  };
  return Object.assign(s, { url: `http://localhost:${s.server.port}`, posts: () => reqs.filter((r) => r.method === "POST") });
}

let trello: ReturnType<typeof fake>, github: ReturnType<typeof fake>;
let alice: string, bob: string, admin: string, eve: string;
const TOKEN = "tok_SECRET_0123456789abcdef", KEY = "key0123456789abcdef0123456789ab", PAT = "ghp_SECRETPAT0123456789";
const logs: string[] = [];
const origLog = [console.log, console.info, console.warn, console.error];

beforeAll(() => {
  installFakes();
  trello = fake("trello"); github = fake("github");
  setTrelloBaseForTest(trello.url); setGithubBaseForTest(github.url);
  for (const k of ["log", "info", "warn", "error"] as const) console[k] = ((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }) as never;
});
afterAll(() => {
  removeFakes(); trello.server.stop(true); github.server.stop(true); setTrelloBaseForTest(null); setGithubBaseForTest(null); setMeetingSourceForTest(null);
  [console.log, console.info, console.warn, console.error] = origLog;
});

const mk = (o: Partial<Parameters<typeof addCommitment>[0]> & { text: string; sourceRef: string }) =>
  addCommitment({ sourceType: "message", scopeTag: "shared", channelId: "C1", ownerId: "UBOB", ownerName: "User UBOB", assignerId: "UALICE", permalink: "https://slack.example/p/1", ...o });
const taskId = async (ref: string) => (await db.select().from(commitments).where(eq(commitments.sourceRef, ref)))[0]!.id;
const push = (cookie: string, id: string, target: string) => call("POST", `/api/tasks/${id}/push`, { cookie, body: { target } });
const configureTrello = (extra: object = {}) => call("PUT", "/api/settings/integrations/trello", { cookie: admin, body: { key: KEY, token: TOKEN, boardId: "b1", listId: "l1", memberMap: { UBOB: "m1" }, ...extra } });
const configureGithub = () => call("PUT", "/api/settings/integrations/github-issues", { cookie: admin, body: { repo: "acme/web", token: PAT, assigneeMap: { UBOB: "bobgh" }, labels: ["pixel"] } });

beforeEach(async () => {
  await resetDb();
  setMemoryLlm(async () => '{"superseded":[]}');
  trello.reqs.length = 0; github.reqs.length = 0; trello.reply = github.reply = null; trello.n = github.n = 0; logs.length = 0;
  setMeetingSourceForTest(null);
  alice = await login("UALICE", "member"); bob = await login("UBOB", "member"); admin = await login("UADMIN", "admin"); eve = await login("UEVE", "member");
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "secret", isPrivate: true, botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "GP", userId: "UALICE" }, { channelId: "C1", userId: "UALICE" }]);
});

describe("settings", () => {
  test("admin only; GET never returns the token; the stored token is encrypted", async () => {
    expect((await call("PUT", "/api/settings/integrations/trello", { cookie: bob, body: { key: KEY, token: TOKEN } })).status).toBe(403);
    expect((await call("GET", "/api/settings/integrations/trello", { cookie: bob })).status).toBe(403);
    expect(await (await call("GET", "/api/settings/integrations/trello", { cookie: admin })).json()).toMatchObject({ configured: false });
    expect((await configureTrello()).status).toBe(200);
    const got = await (await call("GET", "/api/settings/integrations/trello", { cookie: admin })).json();
    expect(got).toEqual({ configured: true, keyLast4: KEY.slice(-4), boardId: "b1", listId: "l1", memberMap: { UBOB: "m1" } });
    expect(JSON.stringify(got)).not.toContain(TOKEN);
    const [row] = await db.select().from(settings).where(eq(settings.key, "integration:trello"));
    expect(JSON.stringify(row!.value)).not.toContain(TOKEN);
    // omitting the token keeps the stored one
    expect((await configureTrello({ token: undefined, listId: "l2" })).status).toBe(200);
    await mk({ text: "Keep token", sourceRef: "k1" });
    expect((await push(admin, await taskId("k1"), "trello")).status).toBe(200);
    expect(trello.posts()[0]!.query.token).toBe(TOKEN);
    expect(trello.posts()[0]!.body.idList).toBe("l2");
  });
  test("github settings validate the repo and hide the token", async () => {
    const bad = await call("PUT", "/api/settings/integrations/github-issues", { cookie: admin, body: { repo: "not a repo", token: PAT } });
    expect(bad.status).toBe(400);
    await configureGithub();
    const got = await (await call("GET", "/api/settings/integrations/github-issues", { cookie: admin })).json();
    expect(got).toEqual({ configured: true, repo: "acme/web", assigneeMap: { UBOB: "bobgh" }, labels: ["pixel"] });
    expect(JSON.stringify(got)).not.toContain(PAT);
  });
  test("helper endpoints and Test buttons create nothing", async () => {
    await configureTrello();
    expect(await (await call("GET", "/api/integrations/trello/boards", { cookie: admin })).json()).toEqual({ boards: [{ id: "b1", name: "Roadmap" }] });
    expect(await (await call("GET", "/api/integrations/trello/boards/b1/lists", { cookie: admin })).json()).toEqual({ lists: [{ id: "l1", name: "To do" }] });
    expect(await (await call("GET", "/api/integrations/trello/boards/b1/members", { cookie: admin })).json()).toEqual({ members: [{ id: "m1", name: "Bob B", username: "bobb" }] });
    expect((await call("GET", "/api/integrations/trello/boards", { cookie: bob })).status).toBe(403);
    expect(await (await call("POST", "/api/settings/integrations/trello/test", { cookie: admin, body: {} })).json()).toEqual({ ok: true, username: "pixelbot" });
    await configureGithub();
    expect(await (await call("POST", "/api/settings/integrations/github-issues/test", { cookie: admin, body: {} })).json()).toEqual({ ok: true, repo: "acme/web" });
    expect(trello.posts().length + github.posts().length).toBe(0);
    trello.reply = () => new Response("invalid token", { status: 401 });
    const bad = await (await call("POST", "/api/settings/integrations/trello/test", { cookie: admin, body: { key: KEY, token: "tok_wrongwrong" } })).json() as any;
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("rejected the credentials");
  });
});

describe("push to Trello", () => {
  test("creates a card with the exact fields; credentials go in the query string only", async () => {
    await configureTrello();
    await mk({ text: "Ship Tales", sourceRef: "t1", dueAt: new Date("2026-11-02T09:00:00Z"), priority: "urgent" });
    const res = await push(bob, await taskId("t1"), "trello");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, result: { status: "created", url: "https://trello.com/c/card1" } });
    const [r] = trello.posts();
    expect(r).toMatchObject({ path: "/cards", query: { key: KEY, token: TOKEN } });
    expect(Object.keys(r!.body).sort()).toEqual(["desc", "due", "idList", "idMembers", "name", "pos"]);
    expect(r!.body).toMatchObject({ name: "Ship Tales", idList: "l1", idMembers: "m1", due: "2026-11-02T09:00:00.000Z" });
    expect(r!.body.desc).toContain("Source: https://slack.example/p/1");
    expect(r!.body.desc).toContain("Created by Pixel from Slack");
    expect(r!.body.desc).toContain("Priority: urgent");
    expect(r!.body.desc).not.toContain("Owner:"); // mapped owner is a member, not a note
    expect(JSON.stringify(r!.body)).not.toContain(TOKEN);
    const [c] = await db.select().from(commitments).where(eq(commitments.id, await taskId("t1")));
    expect(c!.externalRefs).toEqual([{ provider: "trello", id: "card1", url: "https://trello.com/c/card1" }]);
    const audit = await db.select().from(integrationPushes);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: "UBOB", target: "trello", status: "ok", externalId: "card1" });
  });
  test("owner without a member mapping: no idMembers, Owner note in the description", async () => {
    await configureTrello({ memberMap: {} });
    await mk({ text: "Unmapped owner", sourceRef: "t2" });
    await push(bob, await taskId("t2"), "trello");
    const b = trello.posts()[0]!.body;
    expect(b.idMembers).toBeUndefined();
    expect(b.due).toBeUndefined();
    expect(b.desc).toContain("Owner: User UBOB");
  });
  test("idempotent: a second push returns the existing link and creates nothing", async () => {
    await configureTrello();
    await mk({ text: "Once only", sourceRef: "t3" });
    const id = await taskId("t3");
    await push(bob, id, "trello");
    const again = await (await push(bob, id, "trello")).json() as any;
    expect(again).toMatchObject({ existing: 1, result: { status: "existing", url: "https://trello.com/c/card1" } });
    const concurrent = await Promise.all([push(bob, id, "trello"), push(alice, id, "trello")]);
    expect(concurrent.every((r) => r.status === 200)).toBe(true);
    expect(trello.posts()).toHaveLength(1);
  });
  test("401 / 429 / 404 give clear messages, are audited, and leak no secrets", async () => {
    await configureTrello();
    await mk({ text: "Fails", sourceRef: "t4" });
    const id = await taskId("t4");
    trello.reply = () => new Response("unauthorized", { status: 401 });
    let r = await push(bob, id, "trello");
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).result.reason).toContain("rejected the credentials");
    trello.reply = () => new Response("slow down", { status: 429, headers: { "retry-after": "17" } });
    r = await push(bob, id, "trello");
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).result.reason).toContain("retry in 17s");
    trello.reply = () => new Response("invalid id", { status: 404 });
    r = await push(bob, id, "trello");
    expect(((await r.json()) as any).result.reason).toContain("could not find the board, list or repository");
    const audit = await db.select().from(integrationPushes);
    expect(audit.map((a) => a.status)).toEqual(["failed", "failed", "failed"]);
    // failures are retryable: nothing was recorded as pushed
    trello.reply = null;
    expect(((await (await push(bob, id, "trello")).json()) as any).result.status).toBe("created");
    const everything = JSON.stringify(audit) + logs.join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(KEY);
  });
  test("not configured -> 409 with a clear message", async () => {
    await mk({ text: "Nowhere", sourceRef: "t5" });
    const r = await push(bob, await taskId("t5"), "trello");
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).message).toContain("not configured");
  });
});

describe("push to GitHub Issues", () => {
  test("creates an issue with the exact fields", async () => {
    await configureGithub();
    await mk({ text: "Fix login", sourceRef: "g1", dueAt: new Date("2026-11-02T09:00:00Z") });
    const res = await push(alice, await taskId("g1"), "github");
    expect(await res.json()).toMatchObject({ created: 1, result: { status: "created", url: "https://github.com/acme/web/issues/1" } });
    const [r] = github.posts();
    expect(r!.path).toBe("/repos/acme/web/issues");
    expect(r!.headers.get("authorization")).toBe(`Bearer ${PAT}`);
    expect(Object.keys(r!.body).sort()).toEqual(["assignees", "body", "labels", "title"]);
    expect(r!.body).toMatchObject({ title: "Fix login", labels: ["pixel", "due:2026-11-02"], assignees: ["bobgh"] });
    expect(r!.body.body).toContain("Due: 2026-11-02");
    expect(r!.body.body).toContain("Owner: User UBOB");
    expect(r!.body.body).toContain("Source: https://slack.example/p/1");
    expect(JSON.stringify(r!.body)).not.toContain(PAT);
    expect((await db.select().from(commitments).where(eq(commitments.sourceRef, "g1")))[0]!.externalRefs[0]).toMatchObject({ provider: "github", id: "1" });
  });
  test("no assignee when unmapped, no due label without a due date; idempotent per target (trello push is separate)", async () => {
    await configureGithub(); await configureTrello();
    await mk({ text: "Plain", sourceRef: "g2", ownerId: "UCARL", ownerName: "Carl" });
    const id = await taskId("g2");
    await push(admin, id, "github");
    const b = github.posts()[0]!.body;
    expect(b.assignees).toBeUndefined();
    expect(b.labels).toEqual(["pixel"]);
    expect(b.body).not.toContain("Due:");
    expect(((await (await push(admin, id, "github")).json()) as any).result.status).toBe("existing");
    expect(((await (await push(admin, id, "trello")).json()) as any).result.status).toBe("created");
    expect(github.posts()).toHaveLength(1);
  });
  test("403 without rate-limit headers is a credentials problem; 429 reports Retry-After", async () => {
    await configureGithub();
    await mk({ text: "Perm", sourceRef: "g3" });
    const id = await taskId("g3");
    github.reply = () => new Response("{}", { status: 403 });
    expect(((await (await push(alice, id, "github")).json()) as any).result.reason).toContain("rejected the credentials");
    github.reply = () => new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    expect(((await (await push(alice, id, "github")).json()) as any).result.reason).toContain("retry in 60s");
    github.reply = () => new Response("{}", { status: 404 });
    expect(((await (await push(alice, id, "github")).json()) as any).result.reason).toContain("404");
  });
});

describe("permissions and scope", () => {
  test("a member cannot push someone else's task; admin, owner and assigner can", async () => {
    await configureTrello();
    await mk({ text: "Not eve's", sourceRef: "p1" });
    const id = await taskId("p1");
    expect((await push(eve, id, "trello")).status).toBe(403);
    expect(trello.posts()).toHaveLength(0);
    expect((await push(bob, id, "trello")).status).toBe(200);
    expect((await push(alice, id, "trello")).status).toBe(200); // existing link
  });
  test("a private-channel task is invisible: 404 for a non-member (member or admin), never pushed", async () => {
    await configureTrello();
    await mk({ text: "Secret plan", sourceRef: "p2", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    const id = await taskId("p2");
    for (const who of [bob, admin, eve]) expect((await push(who, id, "trello")).status).toBe(404);
    expect(trello.posts()).toHaveLength(0);
    expect((await push(alice, id, "trello")).status).toBe(200);
    // and a forged id behaves identically
    expect((await push(admin, "cm_forged", "trello")).status).toBe(404);
  });
  test("an already-pushed private task does not leak its link to an outsider", async () => {
    await configureTrello();
    await mk({ text: "Secret plan", sourceRef: "p3", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    const id = await taskId("p3");
    await push(alice, id, "trello");
    const r = await push(bob, id, "trello");
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("trello.com");
  });
  test("bulk: partial failure is reported per task and the rest still go", async () => {
    await configureTrello();
    await mk({ text: "Good one", sourceRef: "b1" });
    await mk({ text: "Bad one", sourceRef: "b2" });
    await mk({ text: "Secret", sourceRef: "b3", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    await mk({ text: "Eve's no", sourceRef: "b4", ownerId: "UCARL", assignerId: "UALICE" });
    const ids = await Promise.all(["b1", "b2", "b3", "b4"].map(taskId));
    trello.reply = (r) => (r.body?.name === "Bad one" ? new Response("{}", { status: 500 }) : null);
    const res = await (await call("POST", "/api/tasks/push", { cookie: bob, body: { target: "trello", ids } })).json() as any;
    expect(res).toMatchObject({ created: 1, failed: 1, skipped: 2 });
    expect(res.results.map((r: any) => [r.title, r.status])).toEqual([["Good one", "created"], ["Bad one", "failed"], ["(unavailable)", "skipped"], ["Eve's no", "skipped"]]);
    expect(JSON.stringify(res)).not.toContain("Secret");
  });
  test("bulk stops hammering after a rate limit", async () => {
    await configureTrello();
    await mk({ text: "One", sourceRef: "r1" }); await mk({ text: "Two", sourceRef: "r2" });
    trello.reply = () => new Response("{}", { status: 429, headers: { "retry-after": "5" } });
    const ids = await Promise.all(["r1", "r2"].map(taskId));
    const res = await (await call("POST", "/api/tasks/push", { cookie: admin, body: { target: "trello", ids } })).json() as any;
    expect(res.results.map((r: any) => r.status)).toEqual(["failed", "skipped"]);
    expect(trello.posts()).toHaveLength(1);
  });
  test("audit list is admin-only and shows pushes", async () => {
    await configureTrello();
    await mk({ text: "Audited", sourceRef: "a1" });
    await push(bob, await taskId("a1"), "trello");
    expect((await call("GET", "/api/integrations/pushes", { cookie: bob })).status).toBe(403);
    const l = await (await call("GET", "/api/integrations/pushes", { cookie: admin })).json() as any;
    expect(l.pushes[0]).toMatchObject({ userId: "UBOB", target: "trello", status: "ok" });
  });
});

describe("meeting items", () => {
  const item = (o: Partial<MeetingItemRow>): MeetingItemRow => ({
    meeting: { id: "mt_1", title: "Planning" }, itemType: "task", title: "T", assignee: "User UBOB", due: "2026-11-02", priority: "normal", kind: "commitment", label: "", confidence: 0.9,
    approval: "approved", quote: "I will do it", status: "open", externalUrl: null, itemId: "i1", assigneeId: "UBOB", description: "details", ...o,
  });
  const refs: any[] = [];
  beforeEach(async () => {
    refs.length = 0;
    await db.insert(meetings).values({ id: "mt_1", sourceFileId: "F1", channelId: "GP", title: "Planning", transcript: "x", status: "ready" });
    setMeetingSourceForTest({
      meetingItemsForExport: async () => [
        item({ itemId: "i1", title: "Approved task" }),
        item({ itemId: "i2", title: "Proposed task", approval: "proposed" }),
        item({ itemId: "i3", title: "Rejected task", approval: "rejected" }),
        item({ itemId: "i4", title: "A question", itemType: "question" }),
        item({ itemId: "i5", title: "A suggestion", itemType: "suggestion", approval: "approved" }),
        item({ itemId: "i6", title: "Someone else's", assigneeId: "UCARL", assignee: "Carl" }),
      ],
      setMeetingItemExternalRef: async (m, i, r) => { refs.push([m, i, r]); },
    });
  });

  test("only approved tasks are pushed by 'all: approved'; the ref is written back; second call is idempotent", async () => {
    await configureTrello();
    await db.insert(channelMembers).values({ channelId: "GP", userId: "UBOB" });
    const res = await (await call("POST", "/api/meetings/mt_1/push", { cookie: admin, body: { target: "trello", all: "approved" } })).json() as any;
    expect(res.results.map((r: any) => [r.title, r.status])).toEqual([["Approved task", "created"], ["Someone else's", "created"]]);
    const card = trello.posts()[0]!.body;
    expect(card).toMatchObject({ name: "Approved task", idMembers: "m1" });
    expect(card.desc).toContain("details");
    expect(card.desc).toContain("> I will do it");
    expect(card.desc).toContain('Created by Pixel from meeting "Planning"');
    expect(refs[0]).toEqual(["mt_1", "i1", { provider: "trello", id: "card1", url: "https://trello.com/c/card1" }]);
    const again = await (await call("POST", "/api/meetings/mt_1/push", { cookie: admin, body: { target: "trello", all: "approved" } })).json() as any;
    expect(again.results.map((r: any) => r.status)).toEqual(["existing", "existing"]);
    expect(trello.posts()).toHaveLength(2);
  });
  test("explicit ids of proposed / rejected / question / suggestion items are refused, never sent", async () => {
    await configureTrello();
    const res = await (await call("POST", "/api/meetings/mt_1/push", { cookie: admin, body: { target: "trello", itemIds: ["i2", "i3", "i4", "i5", "nope"] } })).json() as any;
    expect(res.created).toBe(0);
    expect(res.results.map((r: any) => r.reason)).toEqual(["Not approved yet (proposed)", "Not approved yet (rejected)", "A question is not a task", "A suggestion is not a task", "not_found"]);
    expect(trello.posts()).toHaveLength(0);
    const one = await call("POST", "/api/meetings/mt_1/items/i2/push", { cookie: admin, body: { target: "trello" } });
    expect(one.status).toBe(422);
  });
  test("a viewer who is neither organizer nor assignee cannot push; an unreadable meeting is 404", async () => {
    await configureTrello();
    await db.insert(channelMembers).values({ channelId: "GP", userId: "UCARL" });
    await login("UCARL", "member").catch(() => {});
    const r = await call("POST", "/api/meetings/mt_1/items/i1/push", { cookie: alice, body: { target: "trello" } });
    expect(r.status).toBe(403);
    expect((await call("POST", "/api/meetings/mt_1/items/i1/push", { cookie: eve, body: { target: "trello" } })).status).toBe(404);
    expect((await call("POST", "/api/meetings/mt_1/push", { cookie: eve, body: { target: "trello", all: "approved" } })).status).toBe(404);
    expect(trello.posts()).toHaveLength(0);
  });
  test("an approved item that is already a commitment shares its push record", async () => {
    await configureTrello();
    await mk({ text: "Approved task", sourceRef: "meeting:mt_1:i1", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    const cid = await taskId("meeting:mt_1:i1");
    expect((await push(alice, cid, "trello")).status).toBe(200);
    const res = await (await call("POST", "/api/meetings/mt_1/items/i1/push", { cookie: admin, body: { target: "trello" } })).json() as any;
    expect(res.result.status).toBe("existing");
    expect(trello.posts()).toHaveLength(1);
  });
});

describe("export routes", () => {
  const get = (cookie: string, qs: string) => call("GET", `/api/tasks/export${qs}`, { cookie });
  test("formats and filenames", async () => {
    await mk({ text: "=cmd|' /C calc'!A0", sourceRef: "e1", dueAt: new Date("2026-11-02T00:00:00Z") });
    await mk({ text: "Plain, with \"quotes\"", sourceRef: "e2", ownerId: null, ownerName: null });
    expect((await call("GET", "/api/tasks/export")).status).toBe(401);
    const csv = await get(bob, "?format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="tasks-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = await csv.text();
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'=cmd");
    expect(text).toContain('"Plain, with ""quotes"""');
    const json = JSON.parse(await (await get(bob, "?format=json")).text());
    expect(json.count).toBe(2);
    expect((await get(bob, "?format=md")).headers.get("content-disposition")).toContain(".md");
    const ics = await (await get(bob, "?format=ics")).text();
    expect(validateIcs(ics)).toEqual([]);
    expect((await get(bob, "?format=xls")).status).toBe(400);
    expect(JSON.parse(await (await get(bob, "?format=json&unassigned=1")).text()).count).toBe(1);
    expect(JSON.parse(await (await get(bob, "?format=json&noDue=1")).text()).count).toBe(1);
    expect(JSON.parse(await (await get(bob, "?format=json&q=plain")).text()).count).toBe(1);
  });
  test("scope: a private-channel task never appears in another user's export", async () => {
    await mk({ text: "Public thing", sourceRef: "s1" });
    await mk({ text: "Secret plan", sourceRef: "s2", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    await mk({ text: "DM note", sourceRef: "s3", scopeTag: "user_UALICE", channelId: null, ownerId: "UALICE" });
    for (const who of [bob, admin, eve]) for (const f of ["csv", "json", "md", "ics"]) {
      const t = await (await get(who, `?format=${f}`)).text();
      expect(t).toContain("Public thing");
      expect(t).not.toContain("Secret plan");
      expect(t).not.toContain("DM note");
    }
    const mine = await (await get(alice, "?format=json")).text();
    expect(mine).toContain("Secret plan");
    expect(mine).toContain("DM note");
  });
  test("meeting export: readable by members of the channel only", async () => {
    await db.insert(meetings).values({ id: "mt_1", sourceFileId: "F1", channelId: "GP", title: "Planning: Q4!", transcript: "x", status: "ready" });
    setMeetingSourceForTest({ meetingItemsForExport: async () => [{ meeting: { id: "mt_1", title: "Planning: Q4!" }, itemType: "task", title: "=1+1", assignee: "Zoë", due: "2026-11-02", priority: "normal", kind: "commitment", label: "", confidence: 0.5, approval: "proposed", quote: "q", status: "open", externalUrl: null, itemId: "i1" }] });
    const ok = await call("GET", "/api/meetings/mt_1/export?format=csv", { cookie: alice });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(/filename="meeting-planning-q4-\d{4}-\d{2}-\d{2}\.csv"/);
    const body = await ok.text();
    expect(body).toContain("'=1+1");
    expect(body).toContain("proposed");
    for (const f of ["json", "md", "ics"]) expect((await call("GET", `/api/meetings/mt_1/export?format=${f}`, { cookie: alice })).status).toBe(200);
    expect(validateIcs(await (await call("GET", "/api/meetings/mt_1/export?format=ics", { cookie: alice })).text())).toEqual([]);
    expect((await call("GET", "/api/meetings/mt_1/export?format=csv", { cookie: bob })).status).toBe(404);
    expect((await call("GET", "/api/meetings/nope/export?format=csv", { cookie: alice })).status).toBe(404);
  });
});
