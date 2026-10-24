import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { mcpConnections } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { behavior } from "../../src/routes/behavior";
import { settingsRoutes } from "../../src/routes/settings";
import { fakeSlack, seedUsers } from "../turn/helpers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { csrf, type AppEnv } from "../../src/auth/session";
import { login } from "./app";
import { startFakeMcp } from "./fake-server";

// Own app instance: the shared one in ./app has its router built by other files' requests, so routes cannot be added late.
const api = new Hono<AppEnv>();
api.use("*", csrf);
api.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: "internal_error", detail: String(err) }, 500)));
api.route("/", behavior);
api.route("/", settingsRoutes);
const app = new Hono();
app.mount("/api", api.fetch);
function call(method: string, path: string, o: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET") headers["x-requested-with"] = "fetch";
  let body: BodyInit | undefined;
  if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return app.request(path, { method, headers, body });
}

let fake: Awaited<ReturnType<typeof startFakeMcp>>;
let member: string, other: string, admin: string;
let mineId: string, othersId: string, orgId: string;

beforeEach(async () => {
  fake?.stop();
  await resetDb();
  await seedUsers();
  fakeSlack();
  fake = await startFakeMcp();
  member = await login("UASK");
  other = await login("UOWN");
  admin = await login("UADM", "admin");
  mineId = (await createConnection({ provider: "linear", scope: "user", ownerUserId: "UASK", token: "good" })).id;
  othersId = (await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "good" })).id;
  orgId = (await createConnection({ provider: "notion", scope: "org", token: "good" })).id;
});

const list = async (cookie: string) => (await (await call("GET", "/api/mcp/connections", { cookie })).json()) as any[];

describe("connections console API", () => {
  test("scope isolation: members see workspace + their own; admins see everyone with owner names; secrets never leave", async () => {
    expect((await list(member)).map((c) => c.id).sort()).toEqual([mineId, orgId].sort());
    const all = await list(admin);
    expect(all).toHaveLength(3);
    expect(all.find((c) => c.id === othersId)).toMatchObject({ scope: "user", ownerName: "Owner" });
    expect(JSON.stringify(all)).not.toMatch(/authEnc|toolMeta|"good"/);
  });

  test("test endpoint: tool count, read/write split, latency, writes mode; fills the list columns", async () => {
    const r = await (await call("POST", `/api/mcp/connections/${orgId}/test`, { cookie: member, body: {} })).json() as any;
    expect(r).toMatchObject({ ok: true, toolCount: 16, writeCount: 5, readCount: 11, needsReauth: false });
    expect(typeof r.latencyMs).toBe("number");
    const row = (await list(member)).find((c) => c.id === orgId);
    expect(row).toMatchObject({ toolCount: 16, writeCount: 5, readCount: 11, writesEnabled: true, error: null });
    expect(row.lastVerifiedAt).toBeTruthy();
  });

  test("test endpoint: someone else's personal connection is a 404 for members, allowed for admins", async () => {
    expect((await call("POST", `/api/mcp/connections/${othersId}/test`, { cookie: member, body: {} })).status).toBe(404);
    expect((await call("POST", `/api/mcp/connections/${othersId}/test`, { cookie: admin, body: {} })).status).toBe(200);
    expect((await call("POST", `/api/mcp/connections/${orgId}/test`, { body: {} })).status).toBe(401);
  });

  test("test endpoint reports the real error and needs-reconnect", async () => {
    fake.state.mode = "reauth";
    const r = await (await call("POST", `/api/mcp/connections/${orgId}/test`, { cookie: member, body: {} })).json() as any;
    expect(r).toMatchObject({ ok: false, needsReauth: true });
    expect(r.error).toContain("Reconnect");
    const row = (await list(member)).find((c) => c.id === orgId);
    expect(row).toMatchObject({ status: "needs_reauth" });
    expect(row.error).toContain("Reconnect");
    fake.state.mode = "down";
    await db.update(mcpConnections).set({ status: "connected" }).where(eq(mcpConnections.id, orgId));
    const d = await (await call("POST", `/api/mcp/connections/${orgId}/test`, { cookie: member, body: {} })).json() as any;
    expect(d).toMatchObject({ ok: false, needsReauth: false });
    expect(d.error).toContain("Notion did not respond");
  });

  test("make workspace-wide: admin only, confirmed state change; personal-only apps refuse", async () => {
    expect((await call("POST", `/api/mcp/connections/${othersId}/workspace`, { cookie: member, body: {} })).status).toBe(403);
    const r = await (await call("POST", `/api/mcp/connections/${othersId}/workspace`, { cookie: admin, body: {} })).json() as any;
    expect(r).toMatchObject({ scope: "org", ownerUserId: null });
    expect((await list(member)).map((c) => c.id)).toContain(othersId);
    const gm = (await createConnection({ provider: "gmail-personal-only", scope: "user", ownerUserId: "UOWN", token: "x" })).id;
    expect((await call("POST", `/api/mcp/connections/${gm}/workspace`, { cookie: admin, body: {} })).status).toBe(400);
    expect((await call("POST", `/api/mcp/connections/${orgId}/workspace`, { cookie: admin, body: {} })).status).toBe(400);
  });

  test("allow-writes toggle and the workspace setting: admin only", async () => {
    expect((await call("PATCH", `/api/mcp/connections/${orgId}`, { cookie: member, body: { allowWrites: false } })).status).toBe(403);
    expect(await (await call("PATCH", `/api/mcp/connections/${orgId}`, { cookie: admin, body: { allowWrites: false } })).json()).toMatchObject({ allowWrites: false, writesEnabled: false });
    expect(await (await call("PATCH", `/api/mcp/connections/${orgId}`, { cookie: admin, body: { allowWrites: null } })).json()).toMatchObject({ allowWrites: null, writesEnabled: true });
    expect((await call("GET", "/api/settings/mcp-writes", { cookie: member })).status).toBe(403);
    expect(await (await call("GET", "/api/settings/mcp-writes", { cookie: admin })).json()).toEqual({ enabled: true });
    expect(await (await call("PUT", "/api/settings/mcp-writes", { cookie: admin, body: { enabled: false } })).json()).toEqual({ enabled: false });
    expect((await list(member)).find((c) => c.id === orgId)).toMatchObject({ writesEnabled: false });
    expect((await call("PUT", "/api/settings/mcp-writes", { cookie: other, body: { enabled: true } })).status).toBe(403);
  });

  test("health run: admin only, verifies every connected app", async () => {
    expect((await call("POST", "/api/mcp/health/run", { cookie: member, body: {} })).status).toBe(403);
    const r = await (await call("POST", "/api/mcp/health/run", { cookie: admin, body: {} })).json() as any;
    expect(r).toMatchObject({ checked: 3, ok: 3, failed: 0 });
    expect((await list(admin)).every((c) => c.toolCount === 16)).toBe(true);
  });
});
