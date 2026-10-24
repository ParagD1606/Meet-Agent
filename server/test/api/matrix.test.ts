import { beforeAll, describe, expect, test } from "bun:test";
import { call, login, resetDb } from "./helpers";

type R = "member" | "admin" | "owner";
// [method, path, minimum role]. Every REST route must appear here.
const ROUTES: [string, string, R][] = [
  ["GET", "/api/me", "member"],
  ["GET", "/api/users", "admin"],
  ["PUT", "/api/users/x/role", "owner"],
  ["GET", "/api/overview", "member"],
  ["GET", "/api/turns", "admin"],
  ["GET", "/api/tokens", "admin"],
  ["POST", "/api/tokens", "admin"],
  ["DELETE", "/api/tokens/x", "admin"],
  ["GET", "/api/graph", "member"],
  ["GET", "/api/memories", "member"],
  ["DELETE", "/api/memories/1", "admin"],
  ["POST", "/api/memories/upload", "admin"],
  ["GET", "/api/settings/workspace-prompt", "member"],
  ["PUT", "/api/settings/workspace-prompt", "admin"],
  ["GET", "/api/settings/approvals", "admin"],
  ["PUT", "/api/settings/approvals", "admin"],
  ["GET", "/api/settings/proactivity", "admin"],
  ["PUT", "/api/settings/proactivity", "admin"],
  ["GET", "/api/settings/models", "member"],
  ["PUT", "/api/settings/models", "admin"],
  ["GET", "/api/skills", "member"],
  ["POST", "/api/skills", "member"], // personal skills; org scope is admin-checked in the handler
  ["PUT", "/api/skills/x", "member"], // 404 for others' personal skills, 403 for org skills (see skills test)
  ["DELETE", "/api/skills/x", "member"],
  ["GET", "/api/automations", "member"],
  ["POST", "/api/automations", "member"],
  ["PATCH", "/api/automations/x", "member"],
  ["DELETE", "/api/automations/x", "member"],
  ["POST", "/api/automations/x/run", "member"],
  ["GET", "/api/mcp/presets", "member"],
  ["GET", "/api/mcp/connections", "member"],
  ["POST", "/api/mcp/connections", "member"],
  ["DELETE", "/api/mcp/connections/x", "member"],
  ["POST", "/api/mcp/connections/x/connect", "member"],
  ["GET", "/api/sync/sources", "admin"],
  ["POST", "/api/sync/sources", "admin"],
  ["POST", "/api/sync/sources/x/run", "admin"],
  ["DELETE", "/api/sync/sources/x", "admin"],
  ["GET", "/sync/oauth/gdrive/callback", "member"] /* any member may finish their own personal connection; non-personal sources still 403 after the state check */,
  ["GET", "/api/core-blocks", "member"],
  ["GET", "/api/reviews", "admin"],
  ["POST", "/api/reviews/x/decide", "admin"],
  ["GET", "/api/memories/1/history", "member"],
  ["GET", "/api/episodes", "member"],
  ["GET", "/api/turns/x", "admin"],
  ["POST", "/api/setup/test-message", "admin"],
  ["GET", "/api/usage", "admin"],
  ["GET", "/api/marketplace", "member"],
  ["GET", "/api/export/memories", "admin"],
];

const cookies = {} as Record<R, string>;
beforeAll(async () => {
  await resetDb();
  cookies.member = await login("M1", "member");
  cookies.admin = await login("A1", "admin");
  cookies.owner = await login("O1", "owner");
});

const order: R[] = ["member", "admin", "owner"];

describe("auth/role matrix", () => {
  for (const [method, path, min] of ROUTES) {
    test(`${method} ${path} (min ${min})`, async () => {
      expect((await call(method, path, { body: method === "GET" ? undefined : {} })).status).toBe(401);
      for (const role of order) {
        const res = await call(method, path, { cookie: cookies[role], body: method === "GET" ? undefined : {} });
        if (order.indexOf(role) < order.indexOf(min)) expect(res.status).toBe(403);
        else expect([401, 403]).not.toContain(res.status);
      }
    });
  }
});

describe("setup endpoints", () => {
  test("public while no workspace exists, admin-only afterwards", async () => {
    const { db } = await import("./helpers");
    const { workspace } = await import("../../src/db/schema");
    expect((await call("GET", "/api/setup/status")).status).toBe(200);
    expect((await call("GET", "/api/setup/manifest")).status).toBe(200);
    await db.insert(workspace).values({ id: "T1", botTokenEnc: "x", botUserId: "B" });
    expect((await call("GET", "/api/setup/status")).status).toBe(401);
    expect((await call("GET", "/api/setup/manifest", { cookie: cookies.member })).status).toBe(403);
    expect((await call("GET", "/api/setup/status", { cookie: cookies.admin })).status).toBe(200);
    expect((await call("GET", "/api/setup/manifest", { cookie: cookies.admin })).status).toBe(200);
  });
});

describe("validation and scoping", () => {
  test("bodies are zod-validated", async () => {
    const admin = cookies.admin;
    for (const [m, p] of [["POST", "/api/tokens"], ["POST", "/api/skills"], ["PUT", "/api/settings/proactivity"], ["PUT", "/api/settings/workspace-prompt"], ["POST", "/api/sync/sources"], ["POST", "/api/mcp/connections"], ["POST", "/api/automations"]] as const) {
      const res = await call(m, p, { cookie: admin, body: { nonsense: 1 } });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("invalid_body");
    }
    expect((await call("POST", "/api/tokens", { cookie: admin, body: "not-json" as never, headers: { "content-type": "text/plain" } })).status).toBe(400);
  });

  test("unknown /api paths are JSON 404, never the SPA", async () => {
    const res = await call("GET", "/api/nope", { cookie: cookies.member });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("overview shows members only their own turns", async () => {
    const { db } = await import("./helpers");
    const { turns } = await import("../../src/db/schema");
    await db.insert(turns).values([
      { id: "t1", channelId: "C1", userId: "M1", trigger: "mention" },
      { id: "t2", channelId: "C1", userId: "A1", trigger: "mention" },
    ]);
    const m = await (await call("GET", "/api/overview", { cookie: cookies.member })).json() as { recentTurns: { id: string }[] };
    expect(m.recentTurns.map((t) => t.id)).toEqual(["t1"]);
    const a = await (await call("GET", "/api/overview", { cookie: cookies.admin })).json() as { recentTurns: unknown[] };
    expect(a.recentTurns.length).toBe(2);
  });
});
