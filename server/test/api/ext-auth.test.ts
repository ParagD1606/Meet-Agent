import { beforeAll, describe, expect, test } from "bun:test";
import { serverOptions } from "../../src/config";
import { app, call, login, resetDb } from "./helpers";

let auth: Record<string, string>;
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  await resetDb();
  const admin = await login("UEXT", "admin");
  const tok = await (await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } })).json() as any;
  auth = { authorization: `Bearer ${tok.token}` };
});

describe("/ext auth", () => {
  const routes: [string, string][] = [["GET", "/ext/ping"], ["GET", "/ext/meetings/x"], ["POST", "/ext/meetings"], ["POST", "/ext/ask"], ["POST", "/ext/analyze"], ["POST", "/ext/notes"]];
  test.each(routes)("%s %s: missing token is 401", async (method, path) => {
    expect((await app.request(path, { method, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
  });
  test.each(routes)("%s %s: invalid token is 401", async (method, path) => {
    expect((await app.request(path, { method, headers: { authorization: "Bearer nope" }, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
    expect((await app.request(path, { method, headers: { authorization: "Basic abc" }, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
  });
  test("a valid token passes auth", async () => {
    expect((await app.request("/ext/ping", { headers: auth })).status).toBe(200);
  });
});

describe("/ext body limits", () => {
  test("oversize fields and line counts are rejected before any model call", async () => {
    const line = { speaker: "A", text: "x".repeat(4_001) };
    expect((await post("/ext/notes", auth, { lines: [line] })).status).toBe(400);
    expect((await post("/ext/ask", auth, { lines: [{ speaker: "A", text: "hi" }], question: "q".repeat(1_001) })).status).toBe(400);
    expect((await post("/ext/analyze", auth, { lines: Array.from({ length: 20_001 }, () => ({ speaker: "A", text: "hi" })) })).status).toBe(400);
  });
  test("the server caps request bodies (Bun.serve maxRequestBodySize)", () => {
    expect(serverOptions.maxRequestBodySize).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
