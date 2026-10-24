import { beforeEach, describe, expect, test } from "bun:test";
import { call, login, resetDb } from "./helpers";
import { getFreshness, setFreshnessMode } from "../../src/memory/freshness";
import { resetRunNow, RATE_MAX, runners } from "../../src/memory/run-now";
import { db } from "../../src/db";
import { channels } from "../../src/db/schema";

beforeEach(async () => { await resetDb(); resetRunNow(); setFreshnessMode("normal"); });

describe("POST /api/memory/run", () => {
  test("auth: anonymous 401, member 403", async () => {
    expect((await call("POST", "/api/memory/run", { body: { job: "observe" } })).status).toBe(401);
    const member = await login("UM1", "member");
    expect((await call("POST", "/api/memory/run", { cookie: member, body: { job: "observe" } })).status).toBe(403);
  });

  test("admin runs a job, gets counts; unknown job is 400", async () => {
    const admin = await login("UA1", "admin");
    runners["backfill-prefix"] = async () => ({ prefixed: 3 });
    const r = await call("POST", "/api/memory/run", { cookie: admin, body: { job: "backfill-prefix" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, job: "backfill-prefix", counts: { prefixed: 3 } });
    expect((await call("POST", "/api/memory/run", { cookie: admin, body: { job: "nope" } })).status).toBe(400);
  });

  test("single-flight (409 while running) and rate limit (429)", async () => {
    const admin = await login("UA2", "admin");
    let release!: () => void;
    runners.consolidate = () => new Promise((res) => { release = () => res({ merged: 0 }); });
    const first = call("POST", "/api/memory/run", { cookie: admin, body: { job: "consolidate" } });
    await Bun.sleep(50);
    expect((await call("POST", "/api/memory/run", { cookie: admin, body: { job: "consolidate" } })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    runners["capture-flush"] = async () => ({ facts: 0 });
    let last = 200;
    for (let i = 0; i < RATE_MAX + 1; i++) last = (await call("POST", "/api/memory/run", { cookie: admin, body: { job: "capture-flush" } })).status;
    expect(last).toBe(429);
  });
});

describe("settings", () => {
  test("memory-freshness is admin only and persists the mode", async () => {
    const member = await login("UM2", "member");
    const admin = await login("UA3", "admin");
    expect((await call("GET", "/api/settings/memory-freshness", { cookie: member })).status).toBe(403);
    const r = await call("PUT", "/api/settings/memory-freshness", { cookie: admin, body: { mode: "fast" } });
    expect(await r.json()).toMatchObject({ mode: "fast" });
    expect(getFreshness()).toBe("fast");
    expect((await call("PUT", "/api/settings/memory-freshness", { cookie: admin, body: { mode: "turbo" } })).status).toBe(400);
  });

  test("PUT /api/channels/:id/observe is admin only", async () => {
    await db.insert(channels).values({ id: "CAPI", botIsMember: true });
    const member = await login("UM3", "member");
    const admin = await login("UA4", "admin");
    expect((await call("PUT", "/api/channels/CAPI/observe", { cookie: member, body: { observe: false } })).status).toBe(403);
    expect((await call("PUT", "/api/channels/CAPI/observe", { cookie: admin, body: { observe: false } })).status).toBe(200);
    const list = await (await call("GET", "/api/channels/observe", { cookie: admin })).json() as { channels: { id: string; observe: boolean }[] };
    expect(list.channels.find((c) => c.id === "CAPI")!.observe).toBe(false);
    expect((await call("PUT", "/api/channels/NOPE/observe", { cookie: admin, body: { observe: true } })).status).toBe(404);
  });

  test("graph and memories reads are never cached", async () => {
    const admin = await login("UA5", "admin");
    expect((await call("GET", "/api/graph", { cookie: admin })).headers.get("cache-control")).toBe("no-store");
    expect((await call("GET", "/api/memories", { cookie: admin })).headers.get("cache-control")).toBe("no-store");
  });
});
