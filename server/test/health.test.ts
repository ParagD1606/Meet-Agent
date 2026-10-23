import { expect, test } from "bun:test";
import { app } from "../src/app";

test("healthz", async () => {
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("readyz reports db/boss/model and is 503 until everything is up", async () => {
  const res = await app.request("/readyz");
  const body = (await res.json()) as { ok: boolean; checks: { db: boolean; boss: boolean; model: boolean } };
  expect(body.checks.db).toBe(true);
  expect(body.checks.boss).toBe(false); // jobs are not started in tests
  expect(body.ok).toBe(false);
  expect(res.status).toBe(503);
});
