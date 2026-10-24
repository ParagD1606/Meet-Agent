import "../turn/env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { mcpConnections } from "../../src/db/schema";
import { directoryTools } from "../../src/mcp/directory-tool";
import { mountMcpConnect } from "../../src/mcp";
import { mountMarketplaceRoutes } from "../../src/routes/marketplace";
import { setResolver } from "../../src/tools/web/ssrf";
import { fakeSlack, seedUsers } from "../turn/helpers";
import { api, app, call, login } from "./app";

mountMarketplaceRoutes(api);
const landing = new Hono();
mountMcpConnect(landing);
const exec = (tools: any, name: string, input: any) => tools[name].execute(input, { toolCallId: "x", messages: [] });
const tctx = { userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false };

let slack: ReturnType<typeof fakeSlack>;
beforeEach(async () => { setResolver(async () => ["93.184.216.34"]); await resetDb(); await seedUsers(); slack = fakeSlack(); });
afterAll(() => setResolver());

describe("marketplace REST", () => {
  test("search + connected flags; members only", async () => {
    expect((await call("GET", "/api/marketplace")).status).toBe(401);
    const cookie = await login("UM");
    await db.insert(mcpConnections).values({ id: "c1", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "UM", status: "connected" });
    const r = await (await call("GET", "/api/marketplace?q=linear", { cookie })).json() as any;
    expect(r.items[0]).toMatchObject({ key: "linear", connected: true, connectMode: "oauth" });
    expect(r.total).toBeGreaterThan(0);
    const all = await (await call("GET", "/api/marketplace?limit=5", { cookie })).json() as any;
    expect(all.items).toHaveLength(5);
  });

  test("api-key apps need a token; with one the connection is created connected and the token is stored encrypted", async () => {
    const cookie = await login("UM");
    const { MARKET } = await import("../../src/mcp/directory");
    const key = MARKET.find((m) => m.connectMode === "apikey")!.key;
    const no = await call("POST", `/api/marketplace/${key}/install`, { cookie, body: {} });
    expect(no.status).toBe(400);
    expect((await no.json() as any).error).toBe("token_required");
    const ok = await call("POST", `/api/marketplace/${key}/install`, { cookie, body: { token: "secret-key" } });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(mcpConnections);
    expect(row).toMatchObject({ status: "connected", scope: "user", ownerUserId: "UM" });
    expect(row!.authEnc).not.toContain("secret-key");
  });

  test("org installs need admin; unknown key 404; personal-only presets refuse org", async () => {
    const member = await login("UM");
    const admin = await login("UA", "admin");
    expect((await call("POST", "/api/marketplace/github/install", { cookie: member, body: { scope: "org", token: "t" } })).status).toBe(403);
    expect((await call("POST", "/api/marketplace/github/install", { cookie: member, body: { token: "t" } })).status).toBe(400);
    expect((await call("POST", "/api/marketplace/nope-nope/install", { cookie: member, body: { token: "t" } })).status).toBe(404);
    expect((await call("POST", "/api/marketplace/gmail-personal-only/install", { cookie: admin, body: { scope: "org", token: "t" } })).status).toBe(400);
    expect((await call("POST", "/api/marketplace/github/install", { cookie: admin, body: { scope: "org", token: "t" } })).status).toBe(400);
  });

  test("custom URL is validated; a failed OAuth start leaves no dead pending row", async () => {
    const cookie = await login("UM");
    for (const url of ["http://example.com/mcp", "https://localhost/mcp", "https://10.0.0.1/mcp"]) {
      expect((await call("POST", "/api/marketplace/custom/install", { cookie, body: { url } })).status).toBe(400);
    }
    const r = await call("POST", "/api/marketplace/custom/install", { cookie, body: { url: "https://mcp.nonexistent.invalid/mcp" } });
    expect(r.status).toBe(502);
    expect(await db.select().from(mcpConnections)).toHaveLength(0);
  });
});

describe("connect_app", () => {
  test("search tool returns compact hits; connect_app is absent for read-only / org-only / anonymous turns", () => {
    expect(Object.keys(directoryTools(tctx)).sort()).toEqual(["connect_app", "search_mcp_directory"]);
    for (const over of [{ readOnly: true }, { orgConnectionsOnly: true }, { userId: null }]) {
      expect(Object.keys(directoryTools({ ...tctx, ...over }))).toEqual(["search_mcp_directory"]);
    }
  });

  test("posts a PRIVATE (ephemeral) button to the landing URL of a fresh personal pending connection; reuses it next time", async () => {
    const tools = directoryTools(tctx);
    const r = await exec(tools, "connect_app", { key: "linear" });
    expect(r.status).toBe("button_posted");
    const eph = slack.of("postEphemeral");
    expect(eph).toHaveLength(1);
    expect(slack.of("postMessage")).toHaveLength(0);
    expect(eph[0]!.args).toMatchObject({ channel: "C1", user: "UASK", thread_ts: "1.1" });
    const [conn] = await db.select().from(mcpConnections);
    expect(conn).toMatchObject({ scope: "user", ownerUserId: "UASK", status: "pending", provider: "linear" });
    const button = eph[0]!.args.blocks[1].elements[0];
    expect(button.url).toBe(`http://localhost:3000/mcp-connect/${conn!.id}`);
    await exec(tools, "connect_app", { key: "linear" });
    expect(await db.select().from(mcpConnections)).toHaveLength(1);
  });

  test("already connected, unknown key, and API-key apps (setup link, no button)", async () => {
    const tools = directoryTools(tctx);
    await db.insert(mcpConnections).values({ id: "c1", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "UASK", status: "connected" });
    expect((await exec(tools, "connect_app", { key: "linear" })).message).toContain("already connected");
    expect((await exec(tools, "connect_app", { key: "zzz" })).status).toBe("error");
    const { MARKET } = await import("../../src/mcp/directory");
    const k = MARKET.find((m) => m.connectMode === "apikey")!.key;
    const r = await exec(tools, "connect_app", { key: k });
    expect(r.status).toBe("needs_key");
    expect(r.setupUrl).toContain("/configure/integrations");
    expect(slack.of("postEphemeral")).toHaveLength(0);
  });

  test("when the private button cannot be posted the model is told to use Integrations, not to paste a link", async () => {
    const { setSlackClient } = await import("../../src/turn/slack");
    setSlackClient(async () => ({ chat: { postEphemeral: async () => { throw new Error("channel_not_found"); } } }) as any);
    const r = await exec(directoryTools(tctx), "connect_app", { key: "linear" });
    expect(r.status).toBe("error");
    expect(r.setupUrl).toContain("/configure/integrations");
    expect(JSON.stringify(r)).not.toContain("mcp-connect");
  });
});

describe("GET /mcp-connect/:id", () => {
  const get = (id: string, cookie?: string) => landing.request(`/mcp-connect/${id}`, { headers: cookie ? { cookie } : {} });
  test("401 signed out; neutral 404 for someone else's or unknown id; connected owner sees a done page", async () => {
    const owner = await login("UASK");
    const other = await login("UOTH");
    await db.insert(mcpConnections).values({ id: "p1", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "UASK", status: "pending" });
    expect((await get("p1")).status).toBe(401);
    expect((await get("p1", other)).status).toBe(404);
    expect((await get("missing", owner)).status).toBe(404);
    await db.update(mcpConnections).set({ status: "connected" }).where(eq(mcpConnections.id, "p1"));
    const done = await get("p1", owner);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("already connected");
  });

  test("an org connection id is never forwarded", async () => {
    const owner = await login("UASK");
    await db.insert(mcpConnections).values({ id: "o1", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "org", status: "pending" });
    expect((await get("o1", owner)).status).toBe(404);
  });
});
void app;
