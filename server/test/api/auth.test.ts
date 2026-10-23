import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../../src/config";
import { sessions, users, workspace } from "../../src/db/schema";
import { app, call, db, login, mkUser, resetDb } from "./helpers";

const realFetch = globalThis.fetch;
let identity: Record<string, unknown>;

function mockSlack() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("openid.connect.token")) return Response.json({ ok: true, access_token: "xoxp-test" });
    if (u.includes("openid.connect.userInfo")) return Response.json({ ok: true, ...identity });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

const ident = (uid: string, team = "T1") => ({
  "https://slack.com/user_id": uid, "https://slack.com/team_id": team, name: `Name ${uid}`, email: `${uid}@x.io`,
});

/** Runs the full redirect dance and returns the callback response. */
async function signIn(uid: string, team = "T1", cookieJar = "") {
  identity = ident(uid, team);
  const start = await app.request("/auth/slack");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  expect(loc.hostname).toBe("slack.com");
  const state = loc.searchParams.get("state")!;
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  return app.request(`/auth/slack/callback?code=abc&state=${state}`, { headers: { cookie: `${stateCookie}; ${cookieJar}` } });
}

beforeEach(async () => {
  await resetDb();
  config.SLACK_CLIENT_ID = "cid";
  config.SLACK_CLIENT_SECRET = "csecret";
  config.PUBLIC_URL = "http://localhost:3000";
  mockSlack();
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("slack sign-in", () => {
  test("first sign-in becomes owner, later ones are members", async () => {
    const r1 = await signIn("U1");
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("/setup"); // no workspace installed yet
    const r2 = await signIn("U2");
    expect(r2.status).toBe(302);
    const rows = await db.select().from(users).orderBy(users.id);
    expect(rows.map((u) => [u.id, u.role])).toEqual([["U1", "owner"], ["U2", "member"]]);
    // signing in again keeps the role
    await signIn("U1");
    expect((await db.select().from(users).where(eq(users.id, "U1")))[0]!.role).toBe("owner");
  });

  test("a pre-synced member does not steal ownership once an owner exists; first real sign-in claims it", async () => {
    await mkUser("U9", "member"); // e.g. created by the Slack user sync
    await signIn("U1");
    const roles = Object.fromEntries((await db.select().from(users)).map((u) => [u.id, u.role]));
    expect(roles).toEqual({ U9: "member", U1: "owner" });
  });

  test("session cookie is httpOnly + SameSite=Lax, Secure only on https PUBLIC_URL", async () => {
    const cookie = (await signIn("U1")).headers.getSetCookie().find((c) => c.startsWith("brain_session="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("Max-Age=2592000");

    config.PUBLIC_URL = "https://brain.example.com";
    const secure = (await signIn("U2")).headers.getSetCookie().find((c) => c.startsWith("brain_session="))!;
    expect(secure).toContain("Secure");
    // stored session id is a hash, never the raw cookie token
    const token = cookie.split(";")[0]!.split("=")[1]!;
    expect((await db.select().from(sessions).where(eq(sessions.id, token))).length).toBe(0);
  });

  test("the session works against /api/me, logout kills it", async () => {
    const res = await signIn("U1");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("brain_session="))!.split(";")[0]!;
    const me = await call("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: "U1", role: "owner" });
    expect((await call("POST", "/auth/logout", { cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
  });

  test("rejects bad/missing state and foreign workspaces", async () => {
    const bad = await app.request("/auth/slack/callback?code=abc&state=nope");
    expect(bad.status).toBe(400);
    await db.insert(workspace).values({ id: "T1", botTokenEnc: "x", botUserId: "B1" });
    expect((await signIn("U5", "T-other")).status).toBe(403);
    expect((await db.select().from(users)).length).toBe(0);
    const ok = await signIn("U5", "T1");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
  });

  test("deactivated users cannot sign in or use an old session", async () => {
    const cookie = await login("U3", "member");
    await db.update(users).set({ deactivated: true }).where(eq(users.id, "U3"));
    expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
    expect((await signIn("U3")).status).toBe(403);
  });

  test("503 page when Slack credentials are missing", async () => {
    config.SLACK_CLIENT_ID = undefined;
    expect((await app.request("/auth/slack")).status).toBe(503);
  });
});

describe("csrf", () => {
  test("non-GET /api requires x-requested-with: fetch", async () => {
    const cookie = await login("A1", "admin");
    const body = { name: "t" };
    expect((await call("POST", "/api/tokens", { cookie, body, csrf: false })).status).toBe(403);
    expect((await call("POST", "/api/tokens", { cookie, body, headers: { "x-requested-with": "xhr" }, csrf: false })).status).toBe(403);
    expect((await call("POST", "/api/tokens", { cookie, body })).status).toBe(201);
    expect((await call("GET", "/api/tokens", { cookie })).status).toBe(200); // GET needs no header
    expect((await call("POST", "/auth/logout", { cookie, csrf: false })).status).toBe(403);
  });
});

describe("roles", () => {
  test("only the owner changes roles, never the owner's own", async () => {
    const owner = await login("O1", "owner");
    const admin = await login("A1", "admin");
    await mkUser("M1", "member");
    expect((await call("PUT", "/api/users/M1/role", { cookie: admin, body: { role: "admin" } })).status).toBe(403);
    expect((await call("PUT", "/api/users/M1/role", { cookie: owner, body: { role: "admin" } })).status).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, "M1")))[0]!.role).toBe("admin");
    expect((await call("PUT", "/api/users/M1/role", { cookie: owner, body: { role: "owner" } })).status).toBe(400); // zod enum
    expect((await call("PUT", "/api/users/O1/role", { cookie: owner, body: { role: "member" } })).status).toBe(400);
    expect((await call("PUT", "/api/users/nobody/role", { cookie: owner, body: { role: "member" } })).status).toBe(404);
  });
});
