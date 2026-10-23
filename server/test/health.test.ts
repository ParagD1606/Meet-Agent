import { expect, test } from "bun:test";
import { app } from "../src/app";

test("healthz", async () => {
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
