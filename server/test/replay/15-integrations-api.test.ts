import "../slack/env";
// Replay: the Integrations page and its API. A member must never see (or test) someone else's PERSONAL connection, an admin sees
// owner labels, "Test" works, a dead login surfaces as needs_reauth with the error text and exactly one DM, and nothing secret
// (tokens, URLs with keys, auth blobs) ever reaches the model's prompt, tool results or Slack.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { mcpConnections } from "../../src/db/schema";
import { createSession } from "../../src/auth/session";
import { createConnection } from "../../src/mcp/connections";
import { mountRoutes } from "../../src/routes";
import { ME, PARAG, boot, mention, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";
import { mcp, useFakeMcp } from "./mcp";

const app = new Hono();
mountRoutes(app);

let slack: Slack;
let orgId: string, gh: string, mine: string;
beforeEach(async () => {
  slack = await boot();
});
useFakeMcp();
beforeEach(async () => {
  orgId = (await createConnection({ provider: "notion", scope: "org", token: "good" })).id;
  gh = (await createConnection({ provider: "github", scope: "user", ownerUserId: PARAG, token: "good" })).id;
  mine = (await createConnection({ provider: "linear", scope: "user", ownerUserId: ME, token: "good" })).id;
});
afterAll(teardown);

const api = async (user: string, path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, { ...init, headers: { cookie: `brain_session=${await createSession(null, user)}`, "x-requested-with": "fetch", "content-type": "application/json" } });
const list = async (user: string) => ((await (await api(user, "/mcp/connections")).json()) as any[]);
const reauthDms = () => slack.posts().filter((p) => p.text.includes("needs to be reconnected"));

describe("who sees which connection", () => {
  test("a member sees workspace connections and their own, never another user's personal one", async () => {
    const rows = await list(ME);
    expect(rows.map((r) => r.id).sort()).toEqual([orgId, mine].sort());
    expect(JSON.stringify(rows)).not.toContain(gh);
    expect(JSON.stringify(rows)).not.toContain("Parag");
  });

  test("an admin sees everything, with the owner's name on personal connections", async () => {
    const rows = await list("UADMIN");
    expect(rows.map((r) => r.id).sort()).toEqual([orgId, gh, mine].sort());
    expect(rows.find((r) => r.id === gh)).toMatchObject({ scope: "user", ownerUserId: PARAG, ownerName: "Parag" });
    expect(rows.find((r) => r.id === mine)).toMatchObject({ ownerName: "Dana" });
    expect(rows.find((r) => r.id === orgId)).toMatchObject({ scope: "org", ownerName: null });
  });

  test("the API never returns secrets", async () => {
    const body = JSON.stringify([...(await list("UADMIN")), ...(await list(ME))]);
    expect(body).not.toContain("authEnc");
    expect(body).not.toContain("accessToken");
    expect(body).not.toMatch(/Bearer|"good"/);
  });
});

describe("POST /api/mcp/connections/:id/test", () => {
  test("works for your own and for workspace connections, with the verified tool counts", async () => {
    for (const id of [mine, orgId]) {
      const r = await api(ME, `/mcp/connections/${id}/test`, { method: "POST" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, needsReauth: false, toolCount: 16, writeCount: 5, readCount: 11, connection: { id, status: "connected", toolCount: 16 } });
    }
  });

  test("a member testing someone else's personal connection gets a neutral 404 and nothing runs; an admin can", async () => {
    const r = await api(ME, `/mcp/connections/${gh}/test`, { method: "POST" });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("Parag");
    expect(mcp.fake.calls).toHaveLength(0);
    expect(mcp.fake.state.mode).toBe("ok");
    expect((await api("UADMIN", `/mcp/connections/${gh}/test`, { method: "POST" })).status).toBe(200);
  });

  test("needs_reauth surfaces with the error text and a single DM; recovery clears it", async () => {
    mcp.fake.state.mode = "reauth";
    for (let i = 0; i < 3; i++) {
      const r = await api("UADMIN", `/mcp/connections/${orgId}/test`, { method: "POST" });
      expect(await r.json()).toMatchObject({ ok: false, needsReauth: true, error: expect.stringContaining("Reconnect") });
    }
    // the member's Integrations list shows the real reason
    expect((await list(ME)).find((r) => r.id === orgId)).toMatchObject({ status: "needs_reauth", error: expect.stringContaining("Reconnect") });
    // a workspace connection goes to the admins, once, however many times it was tested
    expect(reauthDms().map((p) => p.channel)).toEqual(["D_UADMIN"]);
    expect(reauthDms()[0]!.text).toContain("/configure/integrations");
    expect((await db.select().from(mcpConnections).where(eq(mcpConnections.id, orgId)))[0]).toMatchObject({ status: "needs_reauth", reauthNotified: true });

    mcp.fake.state.mode = "ok";
    expect(await (await api("UADMIN", `/mcp/connections/${orgId}/test`, { method: "POST" })).json()).toMatchObject({ ok: true });
    expect((await list(ME)).find((r) => r.id === orgId)).toMatchObject({ status: "connected", error: null });
    expect((await db.select().from(mcpConnections).where(eq(mcpConnections.id, orgId)))[0]).toMatchObject({ reauthNotified: false });
  });

  test("a personal connection's reauth DM goes to its owner only", async () => {
    mcp.fake.state.mode = "reauth";
    await api("UADMIN", `/mcp/connections/${gh}/test`, { method: "POST" });
    expect(reauthDms().map((p) => p.channel)).toEqual(["D_" + PARAG]);
  });
});

describe("secrets never reach the model or Slack", () => {
  scriptedTest("connection notes, tool results and replies contain no tokens, key-bearing URLs or auth blobs", async () => {
    const TOKEN = "tok-SECRET-111";
    mcp.fake.state.token = TOKEN;
    await db.delete(mcpConnections);
    await createConnection({ provider: "notion", scope: "org", token: TOKEN });
    await createConnection({ provider: "github", scope: "user", ownerUserId: PARAG, token: TOKEN }); // someone else's: only named
    await db.insert(mcpConnections).values({ id: "mcp_custom", provider: "custom", label: "Acme tool", url: "https://mcp.acme.test/v1?api_key=URLSECRET999", scope: "user", ownerUserId: ME, status: "needs_reauth", lastError: "401 Unauthorized for https://mcp.acme.test/v1?api_key=URLSECRET999" });
    const model = scriptModel((s) => {
      if (s.n === 1) return { call: "search_tools", input: { query: "search roadmap" } };
      if (s.n === 2) return { call: "call_tool", input: { name: "notion__notion-search", args: JSON.stringify({ query: "roadmap" }) } };
      return { text: "Found the Roadmap page." };
    });
    await send(mention("can you search notion for the roadmap page"));
    expect(mcp.fake.calls.at(-1)!.auth).toBe(`Bearer ${TOKEN}`); // the token WAS used, server side
    const prompt = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(prompt).toContain("Acme tool (yours) needs reconnecting"); // the note exists, so the checks below are not vacuous
    expect(prompt).toContain("GitHub (by Parag)");
    const everything = prompt + JSON.stringify(slack.calls.map((c) => c.args));
    for (const secret of [TOKEN, "URLSECRET999", "api_key", "mcp.acme.test", "Bearer", "authEnc", "accessToken", "auth_enc"]) expect(everything).not.toContain(secret);
  });
});
