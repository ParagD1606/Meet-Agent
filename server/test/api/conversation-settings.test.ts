import { describe, expect, test } from "bun:test";
import { getDmIdleHours } from "../../src/turn/reset";
import { call, login, resetDb } from "./helpers";

describe("conversation settings (DM idle auto-reset)", () => {
  test("default 6h; admin sets 0..72; out of range is rejected", async () => {
    await resetDb();
    const admin = await login("UA", "admin");
    expect(((await (await call("GET", "/api/settings/conversation", { cookie: admin })).json()) as any).dmIdleResetHours).toBe(6);
    expect((await call("PUT", "/api/settings/conversation", { cookie: admin, body: { dmIdleResetHours: 0 } })).status).toBe(200);
    expect(await getDmIdleHours()).toBe(0);
    expect((await call("PUT", "/api/settings/conversation", { cookie: admin, body: { dmIdleResetHours: 24 } })).status).toBe(200);
    expect(await getDmIdleHours()).toBe(24);
    for (const v of [-1, 73, "x"]) expect((await call("PUT", "/api/settings/conversation", { cookie: admin, body: { dmIdleResetHours: v } })).status).toBe(400);
    expect(await getDmIdleHours()).toBe(24);
  });

  test("non-admin gets 403 on both verbs; anonymous gets 401", async () => {
    await resetDb();
    const m = await login("UM", "member");
    expect((await call("GET", "/api/settings/conversation", { cookie: m })).status).toBe(403);
    expect((await call("PUT", "/api/settings/conversation", { cookie: m, body: { dmIdleResetHours: 1 } })).status).toBe(403);
    expect((await call("GET", "/api/settings/conversation")).status).toBe(401);
  });
});
