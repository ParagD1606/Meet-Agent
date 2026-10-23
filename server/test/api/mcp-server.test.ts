import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../../src/config";
import { sha256 } from "../../src/crypto";
import { apiTokens, memories } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { app, call, db, login, resetDb } from "./helpers";

const vec = (i: number) => Array.from({ length: config.EMBEDDING_DIM }, (_, k) => (k === i ? 1 : 0));

async function rpc(token: string | null, method: string, params: unknown = {}, id = 1) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

let admin: string;
beforeEach(async () => {
  await resetDb();
  admin = await login("A1", "admin");
});

async function mkToken(name = "ci") {
  const res = await call("POST", "/api/tokens", { cookie: admin, body: { name } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

describe("api tokens", () => {
  test("token is shown once and only its hash is stored", async () => {
    const { id, token } = await mkToken();
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row!.hash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await (await call("GET", "/api/tokens", { cookie: admin })).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(row!.hash);
  });
});

describe("outward MCP server", () => {
  test("rejects missing, malformed and unknown bearer tokens", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("cbt_unknown", "tools/list")).status).toBe(401);
    const res = await app.request("/mcp", { method: "POST", headers: { authorization: "Basic abc" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("lists tools, and a revoked token stops working", async () => {
    const { id, token } = await mkToken();
    const res = await rpc(token, "tools/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(["list_recent", "search_memory"]);
    expect((await call("DELETE", `/api/tokens/${id}`, { cookie: admin })).status).toBe(200);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });

  test("tools only expose the shared tag", async () => {
    const { token } = await mkToken();
    await db.insert(memories).values([
      { scopeTag: "shared", text: "Launch date is March 3", embedding: vec(0) },
      { scopeTag: "channel_C9", text: "Launch secret is private", embedding: vec(0) },
      { scopeTag: "user_U9", text: "Launch DM secret", embedding: vec(0) },
    ]);
    setEmbedder(async (t) => t.map(() => vec(0)));
    try {
      const recent = await rpc(token, "tools/call", { name: "list_recent", arguments: {} });
      const rt = JSON.stringify(await recent.json());
      expect(rt).toContain("March 3");
      expect(rt).not.toContain("secret");

      const search = await rpc(token, "tools/call", { name: "search_memory", arguments: { query: "launch" } });
      const st = JSON.stringify(await search.json());
      expect(st).toContain("March 3");
      expect(st).not.toContain("secret");
    } finally { setEmbedder(null); }
  });

  test("GET /mcp is not allowed (stateless)", async () => {
    expect((await app.request("/mcp")).status).toBe(405);
  });
});
