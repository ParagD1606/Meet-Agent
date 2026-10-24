import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { config } from "../../src/config";
import { decrypt, encrypt } from "../../src/crypto";
import { memories, syncSources } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { runSync } from "../../src/sync";
import { gdrive } from "../../src/sync/providers/gdrive";
import { notion } from "../../src/sync/providers/notion";
import { onedrive } from "../../src/sync/providers/onedrive";
import { app, call, db, login, resetDb } from "./helpers";

const realFetch = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => unknown;
let calls: string[];
let handler: Handler;

function mockFetch(h: Handler) {
  calls = [];
  handler = h;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search}`);
    const out = handler(url, init);
    if (out instanceof Response) return out;
    if (typeof out === "string") return new Response(out);
    return Response.json(out ?? {});
  }) as typeof fetch;
}

const dim = () => config.EMBEDDING_DIM;
beforeEach(async () => {
  await resetDb();
  setEmbedder(async (t) => t.map(() => Array.from({ length: dim() }, (_, k) => (k === 0 ? 1 : 0))));
  Object.assign(config, {
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", MS_CLIENT_ID: "mid", MS_CLIENT_SECRET: "msec",
    NOTION_CLIENT_ID: "nid", NOTION_CLIENT_SECRET: "nsec", PUBLIC_URL: "http://localhost:3000",
  });
});
afterEach(() => { globalThis.fetch = realFetch; setEmbedder(null); });

async function mkSource(provider: "gdrive" | "onedrive" | "notion", cursor: string | null = null, auth: object = { accessToken: "tok" }) {
  const id = `s_${provider}`;
  await db.insert(syncSources).values({ id, provider, authEnc: encrypt(JSON.stringify(auth)), cursor, selection: { ids: ["*"] } });
  return id;
}
const src = async (id: string) => (await db.select().from(syncSources).where(eq(syncSources.id, id)))[0]!;
const shared = (source: string) =>
  db.select().from(memories).where(and(eq(memories.scopeTag, "shared"), eq(memories.source, source)));

describe("google drive", () => {
  const drive: Handler = (u) => {
    const p = u.pathname;
    if (p.endsWith("/changes/startPageToken")) return { startPageToken: "T10" };
    if (p.endsWith("/files") && !u.searchParams.get("pageToken"))
      return { nextPageToken: "P2", files: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document" }, { id: "img", name: "pic", mimeType: "image/png" }] };
    if (p.endsWith("/files") && u.searchParams.get("pageToken") === "P2")
      return { files: [{ id: "f2", name: "notes.txt", mimeType: "text/plain" }, { id: "gone", name: "x", mimeType: "text/plain", trashed: true }] };
    if (p.endsWith("/files/f1/export")) return "Quarterly plan: ship the brain";
    if (p.endsWith("/files/f2")) return "plain notes about onboarding";
    if (p.endsWith("/changes") && u.searchParams.get("pageToken") === "T10")
      return { nextPageToken: "T11", changes: [{ removed: true }, { file: { id: "f2", name: "notes.txt", mimeType: "text/plain" } }] };
    if (p.endsWith("/changes") && u.searchParams.get("pageToken") === "T11")
      return { newStartPageToken: "T12", changes: [] };
    throw new Error(`unexpected ${u}`);
  };

  test("full listing pages through, then switches to the changes token", async () => {
    mockFetch(drive);
    const first = await gdrive.listChanges({ accessToken: "t" }, null);
    expect(first).toEqual({ docs: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document" }], cursor: "full:T10:P2", done: false });
    const second = await gdrive.listChanges({ accessToken: "t" }, first.cursor);
    expect(second.cursor).toBe("T10"); // start token taken before the listing
    expect(second.done).toBe(true);
    expect(second.docs.map((d) => d.id)).toEqual(["f2"]);
  });

  test("runSync ingests into shared, persists the cursor, and next run is incremental", async () => {
    mockFetch(drive);
    const id = await mkSource("gdrive");
    const r1 = await runSync(id);
    expect(r1).toMatchObject({ pages: 2, ingested: 2, failed: 0, done: true });
    expect((await src(id)).cursor).toBe("T10");
    expect((await src(id)).lastSyncAt).not.toBeNull();
    const rows = await shared("gdrive");
    expect(rows.map((r) => r.sourceRef).sort()).toEqual(["f1", "f2"]);
    expect(rows.every((r) => r.kind === "chunk")).toBe(true);

    calls.length = 0;
    const r2 = await runSync(id);
    expect(r2).toMatchObject({ pages: 2, ingested: 1 }); // f2 changed; removal ignored
    expect((await src(id)).cursor).toBe("T12");
    expect(calls.some((c) => c.includes("/changes/startPageToken"))).toBe(false);
    expect(await shared("gdrive")).toHaveLength(2); // re-ingest replaces chunks, no duplicates
  });

  test("a failing doc is counted but does not stop the page or the cursor", async () => {
    mockFetch((u, i) => (u.pathname.endsWith("/files/f1/export") ? new Response("no", { status: 500 }) : drive(u, i)));
    const id = await mkSource("gdrive");
    const r = await runSync(id);
    expect(r).toMatchObject({ ingested: 1, failed: 1, done: true });
    expect((await src(id)).cursor).toBe("T10");
  });

  test("expired access tokens are refreshed and re-encrypted", async () => {
    mockFetch((u, i) => {
      if (u.host === "oauth2.googleapis.com") return { access_token: "fresh", expires_in: 3600 };
      expect((i?.headers as Headers | undefined)?.get?.("authorization")).toBe("Bearer fresh");
      return { newStartPageToken: "T99", changes: [] };
    });
    const id = await mkSource("gdrive", "T12", { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1000 });
    await runSync(id);
    const auth = JSON.parse(decrypt((await src(id)).authEnc!));
    expect(auth).toMatchObject({ accessToken: "fresh", refreshToken: "r" });
    expect((await src(id)).cursor).toBe("T99");
  });
});

describe("onedrive", () => {
  const G = "https://graph.microsoft.com/v1.0";
  test("follows nextLink then stores the deltaLink; skips folders, deletions and unsupported files", async () => {
    mockFetch((u) => {
      if (u.pathname.endsWith("/root/delta") && !u.searchParams.get("skip"))
        return { value: [{ id: "a", name: "a.md", file: {} }, { id: "d", name: "dir" }], "@odata.nextLink": `${G}/me/drive/root/delta?skip=1` };
      if (u.searchParams.get("skip")) return { value: [{ id: "b", name: "b.pdf", file: { mimeType: "application/pdf" } }, { id: "c", name: "c.exe", file: { mimeType: "application/x" } }, { id: "z", name: "z.txt", file: {}, deleted: {} }], "@odata.deltaLink": `${G}/me/drive/root/delta?token=D1` };
      if (u.pathname.endsWith("/items/a/content")) return "# onedrive doc";
      throw new Error(`unexpected ${u}`);
    });
    const p1 = await onedrive.listChanges({ accessToken: "t" }, null);
    expect(p1.done).toBe(false);
    expect(p1.docs).toEqual([{ id: "a", name: "a.md", mimeType: "text/markdown" }]);
    const p2 = await onedrive.listChanges({ accessToken: "t" }, p1.cursor);
    expect(p2).toMatchObject({ done: true, cursor: `${G}/me/drive/root/delta?token=D1` });
    expect(p2.docs.map((d) => d.id)).toEqual(["b"]);
  });

  test("refuses a cursor that points off graph.microsoft.com (token exfiltration guard)", async () => {
    mockFetch(() => ({}));
    await expect(onedrive.listChanges({ accessToken: "t" }, "https://evil.example/delta")).rejects.toThrow("invalid onedrive cursor");
    expect(calls).toHaveLength(0);
  });
});

describe("notion", () => {
  const page = (id: string, t: string, title = id) => ({ id, last_edited_time: t, properties: { Name: { type: "title", title: [{ plain_text: title }] } } });

  test("newest-first paging stops at the watermark and only advances the cursor when complete", async () => {
    let n = 0;
    mockFetch((u, i) => {
      if (u.pathname.endsWith("/search")) {
        const body = JSON.parse(String(i?.body));
        n++;
        if (!body.start_cursor) return { results: [page("p3", "2026-03-03T00:00:00Z"), page("p2", "2026-03-02T00:00:00Z")], has_more: true, next_cursor: "N1" };
        return { results: [page("p1", "2026-03-01T00:00:00Z"), page("p0", "2026-02-01T00:00:00Z")], has_more: true, next_cursor: "N2" };
      }
      throw new Error(`unexpected ${u}`);
    });
    const a = { accessToken: "t" };
    const first = await notion.listChanges(a, "2026-03-01T00:00:00Z"); // p1 is already ingested
    expect(first.done).toBe(false);
    expect(JSON.parse(first.cursor!)).toEqual({ w: "2026-03-01T00:00:00Z", n: "2026-03-03T00:00:00Z", p: "N1" });
    const second = await notion.listChanges(a, first.cursor);
    expect(second).toMatchObject({ done: true, cursor: "2026-03-03T00:00:00Z", docs: [] });
    expect(n).toBe(2);
    expect(first.docs.map((d) => d.id)).toEqual(["p3", "p2"]);
  });

  test("first sync with no more pages stores the newest edit time; nothing new keeps the old cursor", async () => {
    mockFetch(() => ({ results: [page("p1", "2026-03-01T00:00:00Z")], has_more: false, next_cursor: null }));
    expect(await notion.listChanges({ accessToken: "t" }, null)).toMatchObject({ done: true, cursor: "2026-03-01T00:00:00Z" });
    expect(await notion.listChanges({ accessToken: "t" }, "2026-03-01T00:00:00Z")).toMatchObject({ done: true, cursor: "2026-03-01T00:00:00Z", docs: [] });
  });

  test("runSync flattens blocks to text and ingests as source=notion", async () => {
    mockFetch((u) => {
      if (u.pathname.endsWith("/search")) return { results: [page("p1", "2026-03-01T00:00:00Z", "Roadmap")], has_more: false, next_cursor: null };
      if (u.pathname.endsWith("/blocks/p1/children"))
        return { results: [{ id: "b1", type: "paragraph", has_children: true, paragraph: { rich_text: [{ plain_text: "Ship v2 in Q3" }] } }], has_more: false };
      if (u.pathname.endsWith("/blocks/b1/children"))
        return { results: [{ id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "owner: dana" }] } }], has_more: false };
      throw new Error(`unexpected ${u}`);
    });
    const id = await mkSource("notion");
    expect(await runSync(id)).toMatchObject({ ingested: 1, done: true });
    const [row] = await shared("notion");
    expect(row!.text).toContain("Roadmap");
    expect(row!.text).toContain("Ship v2 in Q3");
    expect(row!.text).toContain("owner: dana");
    expect(row!.sourceRef).toBe("p1");
    expect((await src(id)).cursor).toBe("2026-03-01T00:00:00Z");
  });
});

describe("oauth + degradation", () => {
  test("providers without client ids are disabled, not crashing", async () => {
    Object.assign(config, { GOOGLE_CLIENT_ID: undefined });
    expect(gdrive.configured()).toBe(false);
    const admin = await login("A1", "admin");
    const res = await call("POST", "/api/sync/sources", { cookie: admin, body: { provider: "gdrive" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "provider_not_configured" });
    const status = await (await call("GET", "/api/setup/status")).json() as { sync: Record<string, boolean> };
    expect(status.sync).toMatchObject({ gdrive: false, onedrive: true, notion: true, gmail: false, gcal: false, github: false, linear: true, jira: true });
    await db.insert(syncSources).values({ id: "x", provider: "gdrive", authEnc: encrypt("{}") });
    await expect(runSync("x")).rejects.toThrow("not configured");
    expect((await call("POST", "/api/sync/sources/x/run", { cookie: admin })).status).toBe(400);
  });

  test("connect flow: consent URL, state-checked callback, encrypted tokens, first sync", async () => {
    mockFetch((u) => {
      if (u.host === "oauth2.googleapis.com") return { access_token: "AT-secret", refresh_token: "RT-secret", expires_in: 3600 };
      if (u.pathname.endsWith("/changes/startPageToken")) return { startPageToken: "T1" };
      if (u.pathname.endsWith("/files")) return { files: [] };
      throw new Error(`unexpected ${u}`);
    });
    const admin = await login("A1", "admin");
    const start = await call("POST", "/api/sync/sources", { cookie: admin, body: { provider: "gdrive" } });
    expect(start.status).toBe(201);
    const { id, authUrl } = (await start.json()) as { id: string; authUrl: string };
    const u = new URL(authUrl);
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/sync/oauth/gdrive/callback");
    const state = u.searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("brain_sync_state="))!.split(";")[0]!;
    expect(start.headers.getSetCookie().join()).toContain("HttpOnly");

    // wrong state and missing state-cookie are refused
    expect((await app.request(`/sync/oauth/gdrive/callback?code=c&state=bad`, { headers: { cookie: `${admin}; ${stateCookie}` } })).status).toBe(400);
    expect((await app.request(`/sync/oauth/gdrive/callback?code=c&state=${state}`, { headers: { cookie: admin } })).status).toBe(400);
    // a member can't complete it
    const member = await login("M1", "member");
    expect((await app.request(`/sync/oauth/gdrive/callback?code=c&state=${state}`, { headers: { cookie: `${member}; ${stateCookie}` } })).status).toBe(403);

    const ok = await app.request(`/sync/oauth/gdrive/callback?code=c&state=${state}`, { headers: { cookie: `${admin}; ${stateCookie}` } });
    expect(ok.status).toBe(302);
    const row = await src(id);
    expect(row.authEnc).not.toBeNull();
    expect(row.authEnc).not.toContain("AT-secret");
    expect(JSON.parse(decrypt(row.authEnc!))).toMatchObject({ accessToken: "AT-secret", refreshToken: "RT-secret" });

    const list = await (await call("GET", "/api/sync/sources", { cookie: admin })).json();
    expect(JSON.stringify(list)).not.toContain("AT-secret");
    await Bun.sleep(150); // let the fire-and-forget first sync finish before the next test resets the DB
  });
});
