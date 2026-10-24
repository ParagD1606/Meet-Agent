import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { config } from "../../src/config";
import { encrypt } from "../../src/crypto";
import { memories, syncSources } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { runSync } from "../../src/sync";
import { github } from "../../src/sync/providers/github";
import { gmail, gcal } from "../../src/sync/providers/google-personal";
import { adfText, jira } from "../../src/sync/providers/jira";
import { linear } from "../../src/sync/providers/linear";
import { http } from "../../src/sync/types";
import { app, call, db, login, resetDb } from "../api/helpers";

const realFetch = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => unknown;
let calls: string[];
function mockFetch(h: Handler) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const out = h(url, init);
    if (out instanceof Response) return out;
    if (typeof out === "string") return new Response(out);
    return Response.json(out ?? {});
  }) as typeof fetch;
}
beforeEach(async () => {
  await resetDb();
  setEmbedder(async (t) => t.map(() => Array.from({ length: config.EMBEDDING_DIM }, (_, k) => (k === 0 ? 1 : 0))));
  Object.assign(config, { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", PUBLIC_URL: "http://localhost:3000" });
});
afterEach(() => { globalThis.fetch = realFetch; setEmbedder(null); });

async function mk(provider: string, selection: object | null, auth: object = { accessToken: "tok" }, cursor: string | null = null) {
  const id = `s_${provider}`;
  await db.insert(syncSources).values({ id, provider: provider as never, authEnc: encrypt(JSON.stringify(auth)), cursor, selection });
  return id;
}
const rows = (source: string) => db.select().from(memories).where(eq(memories.source, source));
const cursorOf = async (id: string) => (await db.select().from(syncSources).where(eq(syncSources.id, id)))[0]!.cursor;

describe("http rate limits", () => {
  test("retries a 429 honouring Retry-After, then succeeds", async () => {
    let n = 0;
    mockFetch(() => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : { ok: true }));
    expect(await (await http("https://x.test/a")).json()).toEqual({ ok: true });
    expect(n).toBe(2);
  });
  test("a plain 403 is not retried", async () => {
    let n = 0;
    mockFetch(() => { n++; return new Response("no", { status: 403 }); });
    await expect(http("https://x.test/a")).rejects.toThrow("403");
    expect(n).toBe(1);
  });
});

describe("github", () => {
  const gh: Handler = (u) => {
    const p = u.pathname;
    if (p === "/repos/acme/app") return { pushed_at: "2026-02-01T00:00:00Z" };
    if (p === "/repos/acme/app/readme") return { name: "README.md", html_url: "https://github.com/acme/app/blob/main/README.md" };
    if (p === "/repos/acme/app/contents/docs") return [{ type: "file", name: "arch.md", path: "docs/arch.md", html_url: "https://github.com/acme/app/blob/main/docs/arch.md" }, { type: "dir", name: "img", path: "docs/img", html_url: "" }];
    if (p === "/repos/acme/app/contents/README.md") return "# App\nWe use Postgres.";
    if (p === "/repos/acme/app/contents/docs/arch.md") return "Architecture: hono + drizzle";
    if (p === "/repos/acme/app/issues") return [
      { number: 7, title: "Switch queue to pg-boss", updated_at: "2026-01-10T00:00:00Z", html_url: "https://github.com/acme/app/issues/7", state: "open" },
      { number: 8, title: "Fix login", updated_at: "2026-01-12T00:00:00Z", html_url: "https://github.com/acme/app/pull/8", pull_request: {} },
    ];
    if (p === "/repos/acme/app/issues/7") return { title: "Switch queue to pg-boss", body: "We decided to use pg-boss.", state: "closed" };
    if (p === "/repos/acme/app/issues/8") return { title: "Fix login", body: "Fixes the redirect." };
    if (p === "/repos/acme/app/issues/7/comments") return [{ body: "Agreed, going with pg-boss", user: { login: "ana" } }];
    if (p === "/repos/acme/app/issues/8/comments") return [];
    throw new Error(`unexpected ${u}`);
  };

  test("ingests issues, PRs, README and docs with permalinks; no live state; cursor = newest updated_at", async () => {
    mockFetch(gh);
    const id = await mk("github", { ids: ["acme/app"] });
    const r = await runSync(id);
    expect(r).toMatchObject({ ingested: 4, failed: 0, done: true });
    const all = await rows("github");
    const issue = all.find((m) => m.sourceRef === "acme/app#7")!;
    expect(issue.scopeTag).toBe("shared");
    expect(issue.permalink).toBe("https://github.com/acme/app/issues/7");
    expect(issue.text).toContain("pg-boss");
    expect(issue.text).toContain("ana: Agreed");
    expect(all.map((m) => m.text).join(" ")).not.toMatch(/\b(open|closed)\b/i);
    expect(all.find((m) => m.sourceRef === "acme/app:docs/arch.md")!.text).toContain("hono");
    expect(await cursorOf(id)).toBe("2026-01-12T00:00:00Z");
  });

  test("re-sync passes since, skips unchanged issues, and replaces changed ones", async () => {
    mockFetch(gh);
    const id = await mk("github", { ids: ["acme/app"] }, { accessToken: "t" }, "2026-01-12T00:00:00Z");
    await runSync(id);
    // pushed_at (Feb) is after the watermark so docs are re-read, but issues are all <= watermark
    expect(calls.some((c) => c.endsWith("/issues/7"))).toBe(false);
    expect((await rows("github")).map((m) => m.sourceRef).sort()).toEqual(["acme/app:README.md", "acme/app:docs/arch.md"]);
  });

  test("only selected repos are read", async () => {
    mockFetch(gh);
    const out = await github.listChanges({ accessToken: "t" }, null, { ids: ["acme/app"] });
    expect(out.docs.every((d) => d.parents![0] === "acme/app")).toBe(true);
  });
});

describe("linear", () => {
  test("ingests title/description/comments (no status), pages newest-first, selection by team key", async () => {
    const node = (i: number, team: string) => ({ identifier: `${team}-${i}`, title: `T${i}`, description: `desc ${i}`, updatedAt: `2026-03-0${i}T00:00:00Z`, url: `https://linear.app/x/issue/${team}-${i}`, team: { key: team }, comments: { nodes: [{ body: "we chose option B", user: { name: "Bo" } }] } });
    mockFetch((_u, init) => {
      expect((init!.headers as Headers).get("authorization")).toBe("tok"); // raw key, not Bearer
      const v = JSON.parse(String(init!.body)).variables;
      return v.after ? { data: { issues: { nodes: [node(1, "ENG")], pageInfo: { hasNextPage: false, endCursor: null } } } }
        : { data: { issues: { nodes: [node(3, "ENG"), node(2, "OPS")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } };
    });
    const id = await mk("linear", { ids: ["ENG"] });
    const r = await runSync(id);
    expect(r).toMatchObject({ pages: 2, ingested: 2, skipped: 1, done: true });
    const all = await rows("linear");
    expect(all.map((m) => m.sourceRef).sort()).toEqual(["ENG-1", "ENG-3"]);
    expect(all[0]!.text).toContain("option B");
    expect(all[0]!.permalink).toContain("linear.app");
    expect(await cursorOf(id)).toBe("2026-03-03T00:00:00Z");
  });
});

describe("jira", () => {
  test("adf flattening", () => {
    expect(adfText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }, { type: "paragraph", content: [{ type: "text", text: "World" }] }] }).trim()).toBe("Hello\nWorld");
  });
  test("ingests ADF description and comments with Basic auth and browse permalink", async () => {
    const para = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    mockFetch((u, init) => {
      expect(u.pathname).toBe("/rest/api/3/search/jql");
      expect(u.searchParams.get("jql")).toContain('project in ("PAY")');
      expect((init!.headers as Headers).get("authorization")).toStartWith("Basic ");
      return { issues: [{ key: "PAY-1", fields: { summary: "Retry webhooks", description: para("Use exponential backoff"), updated: "2026-04-01T10:00:00.000+0000", project: { key: "PAY" }, comment: { comments: [{ body: para("Decided: 5 retries"), author: { displayName: "Cy" } }] } } }] };
    });
    const id = await mk("jira", { ids: ["PAY"] }, { accessToken: "tok", extra: { baseUrl: "https://acme.atlassian.net", email: "a@acme.com" } });
    expect(await runSync(id)).toMatchObject({ ingested: 1, done: true });
    const [m] = await rows("jira");
    expect(m!.text).toContain("exponential backoff");
    expect(m!.text).toContain("Cy: Decided: 5 retries");
    expect(m!.permalink).toBe("https://acme.atlassian.net/browse/PAY-1");
    expect(await cursorOf(id)).toBe("2026-04-01T10:00:00.000Z");
  });
});

describe("personal gmail + calendar", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  test("gmail chunks land in user_X, never shared", async () => {
    mockFetch((u) => {
      if (u.pathname.endsWith("/messages")) return { messages: [{ id: "m1" }] };
      if (u.pathname.endsWith("/messages/m1")) return { id: "m1", payload: { mimeType: "multipart/alternative", headers: [{ name: "Subject", value: "Offer letter" }, { name: "From", value: "hr@x.com" }], parts: [{ mimeType: "text/plain", body: { data: b64("Salary is confidential") } }] } };
      throw new Error(`unexpected ${u}`);
    });
    const id = await mk("gmail", { ids: ["*"], scopeTag: "user_U1" });
    expect(await runSync(id)).toMatchObject({ ingested: 1 });
    const [m] = await rows("gmail");
    expect(m!.scopeTag).toBe("user_U1");
    expect(m!.text).toContain("Offer letter");
    expect(m!.permalink).toContain("mail.google.com");
    expect((await db.select().from(memories).where(eq(memories.scopeTag, "shared"))).length).toBe(0);
  });

  test("a personal source without an owner tag refuses to sync (no shared fallback)", async () => {
    mockFetch(() => ({}));
    const id = await mk("gmail", { ids: ["*"] });
    await expect(runSync(id)).rejects.toThrow("without an owner");
    expect(calls.length).toBe(0);
  });

  test("calendar skips cancelled events and uses updatedMin cursor", async () => {
    mockFetch(() => ({ items: [
      { id: "e1", summary: "Board meeting", updated: "2026-05-01T00:00:00Z", start: { dateTime: "2026-05-03T09:00:00Z" }, attendees: [{ displayName: "Dee" }], htmlLink: "https://cal/e1" },
      { id: "e2", status: "cancelled", summary: "Gone", updated: "2026-05-02T00:00:00Z" },
    ] }));
    const page = await gcal.listChanges({ accessToken: "t" }, "2026-04-01T00:00:00Z");
    expect(page.docs.map((d) => d.id)).toEqual(["e1"]);
    expect(page.cursor).toBe("2026-05-02T00:00:00Z");
    expect(calls[0]).toContain("calendar/v3");
    void gmail;
  });

  test("routes: member connects own gmail; callback rejects another member; selection edit can't strip scope", async () => {
    const ck = await login("U1");
    const ck2 = await login("U2");
    const r = await call("POST", "/api/sync/personal", { cookie: ck, body: { provider: "gmail" } });
    expect(r.status).toBe(201);
    const { id, authUrl } = (await r.json()) as { id: string; authUrl: string };
    const [s] = await db.select().from(syncSources).where(eq(syncSources.id, id));
    expect(s!.selection).toEqual({ ids: ["*"], scopeTag: "user_U1" });
    const state = new URL(authUrl).searchParams.get("state")!;
    const stateCookie = r.headers.getSetCookie().find((c) => c.startsWith("brain_sync_state="))!.split(";")[0]!;
    const bad = await app.request(`/sync/oauth/gmail/callback?code=c&state=${state}`, { headers: { cookie: `${ck2}; ${stateCookie}` } });
    expect(bad.status).toBe(403);
    const adm = await login("A1", "admin");
    expect((await call("PUT", `/api/sync/sources/${id}`, { cookie: adm, body: { selection: { ids: ["x"] } } })).status).toBe(409);
    expect((await call("POST", "/api/sync/personal", { cookie: ck, body: { provider: "github" } })).status).toBe(400);
  });

  test("token connect route stores an encrypted PAT; selection edit on shared source keeps no scope", async () => {
    const adm = await login("A1", "admin");
    const r = await call("POST", "/api/sync/sources/token", { cookie: adm, body: { provider: "github", token: "ghp_abcdefgh" } });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await db.select().from(syncSources).where(and(eq(syncSources.id, id))))[0]!.authEnc).not.toContain("ghp_");
    expect((await call("POST", "/api/sync/sources/token", { cookie: adm, body: { provider: "jira", token: "abcdefgh12" } })).status).toBe(400);
    expect((await call("PUT", `/api/sync/sources/${id}`, { cookie: adm, body: { selection: { ids: ["acme/app"] } } })).status).toBe(200);
  });
});
