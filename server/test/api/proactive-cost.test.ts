import { beforeEach, describe, expect, test } from "bun:test";
import { call, login, resetDb } from "./helpers";

beforeEach(resetDb);
const body = async (r: Response) => (await r.json()) as any;

describe("proactive features + cost admin routes", () => {
  test("admin-only", async () => {
    const member = await login("UM", "member");
    expect((await call("GET", "/api/settings/proactive-features", { cookie: member })).status).toBe(403);
    expect((await call("PUT", "/api/settings/proactive-features", { cookie: member, body: { digest: ["C1"] } })).status).toBe(403);
    expect((await call("GET", "/api/usage/cost", { cookie: member })).status).toBe(403);
  });

  test("per-feature channel lists round-trip and a partial PUT leaves the other features alone", async () => {
    const admin = await login("UA", "admin");
    expect(await body(await call("GET", "/api/settings/proactive-features", { cookie: admin }))).toEqual({ digest: [], nudge: [], deadlines: [], autoreply: [] });
    await call("PUT", "/api/settings/proactive-features", { cookie: admin, body: { digest: ["C1", "C1", "C2"], nudge: ["C1"] } });
    const r = await body(await call("PUT", "/api/settings/proactive-features", { cookie: admin, body: { nudge: [] } }));
    expect(r).toEqual({ digest: ["C1", "C2"], nudge: [], deadlines: [], autoreply: [] });
    expect((await call("PUT", "/api/settings/proactive-features", { cookie: admin, body: { digest: [""] } })).status).toBe(400);
  });

  test("GET /api/usage/cost returns the report shape", async () => {
    const admin = await login("UA", "admin");
    const r = await body(await call("GET", "/api/usage/cost?days=7", { cookie: admin }));
    expect(r).toMatchObject({ days: 7, totalUsd: 0, byDay: [], byModel: [], month: { spentUsd: 0 } });
  });
});
