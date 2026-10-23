import "./env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../../src/config";
import { encrypt, sha256 } from "../../src/crypto";
import { db, pool } from "../../src/db";
import { apiTokens, channelMembers, channels, events, leases, mcpConnections, researchRuns, sessions, syncSources, turns, users } from "../../src/db/schema";
import { enqueueResearch, getBoss, purgeOld, Q, startJobs, stopJobs } from "../../src/jobs";
import { AuthDecryptError, DbOAuthProvider, readAuth, updateAuth, writeAuth } from "../../src/mcp/oauth";
import { handleOAuthCallback } from "../../src/mcp/connections";
import { claimEvent, releaseEvent, withEventClaim } from "../../src/slack/dedupe";
import { defaultFetch, isSlackFileHost } from "../../src/slack/attachments";
import { resyncChannelMembers, userIsChannelMember } from "../../src/slack/sync";
import { consumeLease, grantedLeases } from "../../src/turn/lease";
import { runSync } from "../../src/sync";
import { selectionIncludes } from "../../src/sync/types";
import { sniffUpload } from "../../src/routes/util";
import { app, call, login, resetDb } from "../api/helpers";
import { setEmbedder } from "../../src/memory/embed";
import { ownerExists, teamAllowed, verifySetupToken } from "../../src/auth/setup-token";
import { installGate } from "../../src/slack/install";
import { Hono } from "hono";
import { app as fullApp } from "../../src/app";

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });

describe("owner lock helpers", () => {
  test("setup token + team pin", async () => {
    config.SETUP_TOKEN = "tok-1"; config.SLACK_TEAM_ID = "T9";
    expect(verifySetupToken("tok-1")).toBe(true);
    expect(verifySetupToken("tok-2")).toBe(false);
    expect(verifySetupToken(undefined)).toBe(false);
    expect(teamAllowed("T9")).toBe(true);
    expect(teamAllowed("T8")).toBe(false);
    config.SLACK_TEAM_ID = undefined;
    expect(teamAllowed("anything")).toBe(true);
    expect(await ownerExists()).toBe(false);
  });
  test("install gate: no workspace and no pin needs the setup token; pinned deployments pass", async () => {
    config.SETUP_TOKEN = "tok-1"; config.SLACK_TEAM_ID = undefined;
    const a = new Hono();
    a.use("/slack/*", installGate);
    a.get("/slack/install", (c) => c.text("ok"));
    a.get("/slack/oauth/callback", (c) => c.text("cb"));
    expect((await a.request("/slack/install")).status).toBe(403);
    expect((await a.request("/slack/oauth/callback")).status).toBe(403);
    expect((await a.request("/slack/install?setup_token=bad")).status).toBe(403);
    const ok = await a.request("/slack/install?setup_token=tok-1");
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie()[0]!.split(";")[0]!;
    expect((await a.request("/slack/oauth/callback", { headers: { cookie } })).status).toBe(200);
    config.SLACK_TEAM_ID = "T1";
    expect((await a.request("/slack/install")).status).toBe(200);
  });
});

describe("sync selection", () => {
  test("nothing syncs without an admin selection; PUT validates and resets the cursor", async () => {
    setEmbedder(async (t) => t.map(() => Array.from({ length: config.EMBEDDING_DIM }, (_, k) => (k === 0 ? 1 : 0))));
    Object.assign(config, { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" });
    const admin = await login("A1", "admin");
    const member = await login("M1", "member");
    await db.insert(syncSources).values({ id: "s1", provider: "gdrive", authEnc: encrypt(JSON.stringify({ accessToken: "t" })), cursor: "T5" });
    expect(await runSync("s1")).toMatchObject({ pages: 0, ingested: 0, done: true });
    expect((await call("POST", "/api/sync/sources/s1/run", { cookie: admin })).status).toBe(409);
    expect((await call("PUT", "/api/sync/sources/s1", { cookie: member, body: { selection: { ids: ["f"] } } })).status).toBe(403);
    expect((await call("PUT", "/api/sync/sources/s1", { cookie: admin, body: { selection: { ids: [] } } })).status).toBe(400);
    expect((await call("PUT", "/api/sync/sources/nope", { cookie: admin, body: { selection: { ids: ["f"] } } })).status).toBe(404);
    const res = await call("PUT", "/api/sync/sources/s1", { cookie: admin, body: { selection: { ids: ["folder1"] } } });
    expect(await res.json()).toEqual({ id: "s1", selection: { ids: ["folder1"] } });
    const [row] = await db.select().from(syncSources);
    expect(row!.cursor).toBeNull();
    const list = await (await call("GET", "/api/sync/sources", { cookie: admin })).json() as any[];
    expect(list[0].selection).toEqual({ ids: ["folder1"] });
    setEmbedder(null);
  });
  test("selectionIncludes: ids match the doc, its parent folder, or '*'", () => {
    const d = { id: "d1", name: "n", mimeType: "text/plain", parents: ["f1"] };
    expect(selectionIncludes(null, d)).toBe(false);
    expect(selectionIncludes({ ids: [] }, d)).toBe(false);
    expect(selectionIncludes({ ids: ["f1"] }, d)).toBe(true);
    expect(selectionIncludes({ ids: ["d1"] }, { ...d, parents: undefined })).toBe(true);
    expect(selectionIncludes({ ids: ["f2"] }, d)).toBe(false);
    expect(selectionIncludes({ ids: ["*"] }, d)).toBe(true);
  });
});

describe("scope fail-closed helpers", () => {
  test("membership recheck denies on Slack errors and corrects the cache otherwise", async () => {
    await db.insert(channelMembers).values({ channelId: "CP", userId: "UA" });
    const failing = { conversations: { members: async () => { throw new Error("slack down"); } } } as any;
    expect(await userIsChannelMember("CP", "UA", failing)).toBe(false); // cached "member" is not trusted when Slack is unreachable
    const live = (members: string[]) => ({ conversations: { members: async () => ({ members, response_metadata: {} }) } }) as any;
    expect(await userIsChannelMember("CP", "UA", live(["UB"]))).toBe(false);
    expect(await db.select().from(channelMembers).where(eq(channelMembers.userId, "UA"))).toHaveLength(0);
    expect(await userIsChannelMember("CP", "UB", live(["UB"]))).toBe(true);
    expect(await db.select().from(channelMembers).where(eq(channelMembers.userId, "UB"))).toHaveLength(1);
  });
  test("periodic resync removes members who left, private channels first, one failure does not stop the rest", async () => {
    await db.insert(channels).values([{ id: "C1", isPrivate: false, botIsMember: true }, { id: "C2", isPrivate: true, botIsMember: true }, { id: "C3", isPrivate: true, botIsMember: false }]);
    await db.insert(channelMembers).values([{ channelId: "C2", userId: "OLD" }, { channelId: "C1", userId: "X" }]);
    const order: string[] = [];
    const client = { conversations: { members: async ({ channel }: any) => { order.push(channel); if (channel === "C2") return { members: ["NEW"] }; throw new Error("boom"); } } } as any;
    expect(await resyncChannelMembers(client)).toEqual({ channels: 2, failed: 1 });
    expect(order).toEqual(["C2", "C1"]);
    expect((await db.select().from(channelMembers).where(eq(channelMembers.channelId, "C2"))).map((m) => m.userId)).toEqual(["NEW"]);
  });
  test("leases are bound to connection, originating thread and read-only tools", async () => {
    await db.insert(turns).values([
      { id: "tA", channelId: "C1", threadTs: "1.1", userId: "UR", trigger: "mention" },
    ]);
    const mk = (id: string) => db.insert(leases).values({ id, connectionId: "conn1", ownerUserId: "UO", requesterId: "UR", turnId: "tA", status: "granted", expiresAt: new Date(Date.now() + 60_000) });
    await mk("l1");
    const bind = { connectionId: "conn1", toolIsRead: true, channelId: "C1", threadTs: "1.1" };
    expect(await consumeLease("l1", "UR", { ...bind, toolIsRead: false })).toBe(false); // writes can never spend a lease
    expect(await consumeLease("l1", "UR", { ...bind, connectionId: "other" })).toBe(false);
    expect(await consumeLease("l1", "UR", { ...bind, channelId: "C2" })).toBe(false);
    expect(await consumeLease("l1", "UR", { ...bind, threadTs: "9.9" })).toBe(false);
    expect(await grantedLeases("UR", { channelId: "C2", threadTs: "1.1" })).toHaveLength(0);
    expect(await grantedLeases("UR", { channelId: "C1", threadTs: "1.1" })).toHaveLength(1);
    expect(await consumeLease("l1", "UR", bind)).toBe(true);
    expect(await consumeLease("l1", "UR", bind)).toBe(false);
  });
});

describe("MCP credentials", () => {
  const conn = async (id = "mcp_x") => {
    await db.insert(mcpConnections).values({ id, provider: "custom", label: "x", url: "https://x.example", scope: "org" });
    return id;
  };
  test("undecryptable blob throws instead of silently becoming 'no auth'", async () => {
    const id = await conn();
    await db.update(mcpConnections).set({ authEnc: "bm90LXZhbGlk" }).where(eq(mcpConnections.id, id));
    await expect(readAuth(id)).rejects.toBeInstanceOf(AuthDecryptError);
    await expect(writeAuth(id, { state: "s" })).rejects.toBeInstanceOf(AuthDecryptError); // never overwrites what it cannot read
    await writeAuth(id, { accessToken: "fresh" }, true); // an explicit reconnect replaces it
    expect((await readAuth(id)).accessToken).toBe("fresh");
  });
  test("concurrent read-modify-writes do not lose updates", async () => {
    const id = await conn();
    await writeAuth(id, {}, true);
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateAuth(id, (cur) => ({ ...cur, expiresAt: (cur.expiresAt ?? 0) + 1, clientInfo: { client_id: `c${i}` } as any }))));
    expect((await readAuth(id)).expiresAt).toBe(20);
  });
  test("OAuth state expires", async () => {
    const id = await conn();
    const state = await new DbOAuthProvider(id, true).state();
    expect((await readAuth(id)).stateExpiresAt!).toBeGreaterThan(Date.now());
    await writeAuth(id, { stateExpiresAt: Date.now() - 1 });
    await expect(handleOAuthCallback("code", state)).rejects.toThrow(/invalid or expired/);
    await expect(handleOAuthCallback("code", "mcp_x.wrong")).rejects.toThrow(/invalid or expired/);
  });
});

describe("jobs", () => {
  beforeAll(async () => { await resetDb(); await startJobs(); });
  afterAll(async () => { await stopJobs(); });
  test("research enqueue twice: two different runs are both accepted; a duplicate id fails loudly instead of being dropped", async () => {
    await db.insert(researchRuns).values([{ id: "rA", requesterId: "U", channelId: "C", question: "a" }, { id: "rB", requesterId: "U", channelId: "C", question: "b" }]);
    await getBoss().offWork(Q.researchRun); // keep jobs queued so the dedupe is observable
    await enqueueResearch("rA");
    await enqueueResearch("rB"); // old "short" policy returned null here and the run stayed `planned` forever
    await expect(enqueueResearch("rA")).rejects.toThrow(/not enqueued/);
    const { rows } = await pool.query("select data->>'id' as id from pgboss.job where name = $1 and state = 'created'", [Q.researchRun]);
    expect(rows.map((r) => r.id).sort()).toEqual(["rA", "rB"]);
  });
  test("purge removes expired sessions, old events/turns/rate limits but keeps live rows", async () => {
    await db.insert(users).values({ id: "U1", name: "n" });
    await db.insert(sessions).values([{ id: "old", userId: "U1", expiresAt: new Date(Date.now() - 1000) }, { id: "live", userId: "U1", expiresAt: new Date(Date.now() + 1e6) }]);
    await db.insert(events).values([{ id: "e-old", createdAt: new Date(Date.now() - 9 * 86400_000) }, { id: "e-new" }]);
    await db.insert(turns).values([
      { id: "t-old", channelId: "C", trigger: "mention", status: "done", startedAt: new Date(Date.now() - 100 * 86400_000) },
      { id: "t-run", channelId: "C", trigger: "mention", status: "running", startedAt: new Date(Date.now() - 100 * 86400_000) },
      { id: "t-new", channelId: "C", trigger: "mention", status: "done" },
    ]);
    const r = await purgeOld();
    expect(r).toMatchObject({ sessions: 1, events: 1, turns: 1 });
    expect((await db.select().from(sessions)).map((s) => s.id)).toEqual(["live"]);
    expect((await db.select().from(turns)).map((t) => t.id).sort()).toEqual(["t-new", "t-run"]);
  });
});

describe("slack ingress helpers", () => {
  test("event claim is released when the handler fails so a redelivery can retry", async () => {
    await expect(withEventClaim("ev1", async () => { throw new Error("handler crashed"); })).rejects.toThrow();
    expect(await claimEvent("ev1")).toBe(true); // claim was given back
    expect(await withEventClaim("ev1", async () => {})).toBe(false); // now a real duplicate
    await releaseEvent("ev1");
    expect(await withEventClaim("ev1", async () => {})).toBe(true);
  });
  test("file downloads only go to Slack hosts, and never carry the token elsewhere", async () => {
    expect(isSlackFileHost("https://files.slack.com/files-pri/T-F/x.txt")).toBe(true);
    for (const u of ["http://files.slack.com/x", "https://files.slack.com.evil.example/x", "https://evil.example/files.slack.com", "https://user:pw@files.slack.com/x", "https://169.254.169.254/x"]) {
      expect(isSlackFileHost(u)).toBe(false);
      await expect(defaultFetch(u, "xoxb-secret")).rejects.toThrow(/non-Slack/);
    }
  });
  test("downloads are capped while streaming (never buffers a huge body)", async () => {
    const realFetch = globalThis.fetch;
    let pulled = 0;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      pull(ctrl) { pulled += 1_000_000; ctrl.enqueue(new Uint8Array(1_000_000)); if (pulled > 200_000_000) ctrl.close(); },
    }), { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    try {
      const r = await defaultFetch("https://files.slack.com/x", "t");
      expect(r.body.byteLength).toBeLessThanOrEqual(15 * 1024 * 1024 + 1);
      expect(pulled).toBeLessThan(40_000_000);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe("uploads and outward MCP server", () => {
  test("content sniffing decides the type from bytes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffUpload(enc("%PDF-1.7 ..."), "text/plain", "a.txt")).toBe("application/pdf");
    expect(sniffUpload(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), "text/plain", "notes.txt")).toBeNull();
    expect(sniffUpload(enc("hello"), "application/octet-stream", "a.md")).toBe("text/markdown");
    expect(sniffUpload(enc("<p>x"), "", "a.html")).toBe("text/html");
    expect(sniffUpload(enc("plain"), "application/x-evil", "a.bin")).toBe("text/plain");
  });
  test("upload route rejects binaries", async () => {
    const admin = await login("A1", "admin");
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([0, 1, 2, 3, 0])], "x.txt", { type: "text/plain" }));
    const res = await app.request("/api/memories/upload", { method: "POST", headers: { cookie: admin, "x-requested-with": "fetch" }, body: fd });
    expect(res.status).toBe(415);
  });
  test("tokens expire after a year and calls are rate limited", async () => {
    const admin = await login("A1", "admin");
    const tok = (await (await call("POST", "/api/tokens", { cookie: admin, body: { name: "t" } })).json() as any).token as string;
    const rpc = () => app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect((await rpc()).status).toBe(200);
    await db.update(apiTokens).set({ createdAt: new Date(Date.now() - 366 * 86400_000) }).where(eq(apiTokens.hash, sha256(tok)));
    expect((await rpc()).status).toBe(401);
    await db.update(apiTokens).set({ createdAt: new Date() }).where(eq(apiTokens.hash, sha256(tok)));
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await rpc()).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe("limits + ops routes", () => {
  test("GET/PUT /api/settings/limits and /api/usage are admin-only and validated", async () => {
    const admin = await login("A1", "admin");
    const member = await login("M1", "member");
    expect((await call("GET", "/api/usage?range=7d", { cookie: member })).status).toBe(403);
    expect((await call("GET", "/api/usage?range=bogus", { cookie: admin })).status).toBe(400);
    const usage = await (await call("GET", "/api/usage?range=30d", { cookie: admin })).json() as any;
    expect(Object.keys(usage)).toEqual(expect.arrayContaining(["byDay", "byUser", "byModel", "byRole", "cacheHitRate", "avgBreakdown", "topTurns"]));
    const cur = await (await call("GET", "/api/settings/limits", { cookie: admin })).json() as any;
    expect(cur.concurrentTurns).toBeGreaterThan(0);
    expect((await call("PUT", "/api/settings/limits", { cookie: member, body: cur })).status).toBe(403);
    expect((await call("PUT", "/api/settings/limits", { cookie: admin, body: { ...cur, concurrentTurns: -1 } })).status).toBe(400);
    const put = await call("PUT", "/api/settings/limits", { cookie: admin, body: { ...cur, perUserDailyTokens: 123 } });
    expect((await put.json() as any).perUserDailyTokens).toBe(123);
  });
  test("secure headers + request id, /healthz, /readyz shape, GET /api/turns/:id and filters", async () => {
    const h = await fullApp.request("/healthz", { headers: { "x-request-id": "abc-1" } });
    expect(h.headers.get("x-request-id")).toBe("abc-1");
    expect(h.headers.get("x-content-type-options")).toBe("nosniff");
    expect(h.headers.get("x-frame-options")).toBeTruthy();
    const r = await fullApp.request("/readyz");
    const body = await r.json() as any;
    expect(Object.keys(body.checks)).toEqual(expect.arrayContaining(["db", "boss"]));
    const admin = await login("A1", "admin");
    await db.insert(turns).values([
      { id: "ta", channelId: "C1", threadTs: "1.1", userId: "U1", trigger: "mention", status: "done" },
      { id: "tb", channelId: "C2", userId: "U2", trigger: "chime", status: "error" },
    ]);
    expect(((await (await call("GET", "/api/turns?status=error", { cookie: admin })).json()) as any[]).map((t) => t.id)).toEqual(["tb"]);
    expect(((await (await call("GET", "/api/turns?trigger=mention&channel=C1", { cookie: admin })).json()) as any[]).map((t) => t.id)).toEqual(["ta"]);
    expect((await call("GET", "/api/turns/nope", { cookie: admin })).status).toBe(404);
    expect(((await (await call("GET", "/api/turns/ta", { cookie: admin })).json()) as any).id).toBe("ta");
  });
});
