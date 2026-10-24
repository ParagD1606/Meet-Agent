import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import { memories, channels, meetings, meetingTaskNotifications } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { app, call, db, login, mkUser, resetDb } from "./helpers";

let admin: string, member: string;
beforeEach(async () => {
  await resetDb();
  admin = await login("A1", "admin");
  member = await login("M1", "member");
});
const json = async (r: Response) => (await r.json()) as any;
const vec = () => Array.from({ length: config.EMBEDDING_DIM }, (_, k) => (k === 0 ? 1 : 0));

describe("memories + graph", () => {
  test("members see only shared; admins cannot delete non-shared memories", async () => {
    const [a, b] = await db.insert(memories).values([
      { scopeTag: "shared", text: "public fact", embedding: vec() },
      { scopeTag: "channel_C1", text: "private fact", embedding: vec() },
    ]).returning();
    const list = await json(await call("GET", "/api/memories", { cookie: member }));
    expect(list.items.map((m: any) => m.text)).toEqual(["public fact"]);
    const graph = await json(await call("GET", "/api/graph?limit=10", { cookie: member }));
    expect(graph.nodes.map((n: any) => n.scope)).toEqual(["shared"]);
    expect((await call("DELETE", `/api/memories/${b!.id}`, { cookie: admin })).status).toBe(404);
    expect((await call("DELETE", `/api/memories/${a!.id}`, { cookie: admin })).status).toBe(200);
    expect((await call("DELETE", `/api/memories/abc`, { cookie: admin })).status).toBe(400);
  });

  test("upload ingests into shared", async () => {
    setEmbedder(async (t) => t.map(vec));
    try {
      const fd = new FormData();
      fd.set("file", new File(["The wifi password rotates monthly."], "it.txt", { type: "text/plain" }));
      const res = await app.request("/api/memories/upload", { method: "POST", headers: { cookie: admin, "x-requested-with": "fetch" }, body: fd });
      expect(res.status).toBe(201);
      const list = await json(await call("GET", "/api/memories?q=wifi", { cookie: member }));
      expect(list.items[0].source).toBe("upload");
      const none = await app.request("/api/memories/upload", { method: "POST", headers: { cookie: admin, "x-requested-with": "fetch" }, body: new FormData() });
      expect(none.status).toBe(400);
    } finally { setEmbedder(null); }
  });
});

describe("settings", () => {
  test("workspace prompt roundtrip", async () => {
    expect((await json(await call("PUT", "/api/settings/workspace-prompt", { cookie: admin, body: { prompt: " be brief " } }))).prompt).toBe("be brief");
    expect((await json(await call("GET", "/api/settings/workspace-prompt", { cookie: member }))).prompt).toBe("be brief");
  });

  test("approval cards: default off per class, admin can switch a class on", async () => {
    expect((await json(await call("GET", "/api/settings/approvals", { cookie: admin }))).cards).toEqual({ ticket: false, slack_post: false, doc_edit: false, email_calendar: false });
    const res = await json(await call("PUT", "/api/settings/approvals", { cookie: admin, body: { cards: { email_calendar: true } } }));
    expect(res.cards).toEqual({ ticket: false, slack_post: false, doc_edit: false, email_calendar: true });
    expect((await call("PUT", "/api/settings/approvals", { cookie: admin, body: { cards: { ticket: "yes" } } })).status).toBe(400);
  });

  test("proactivity default + per-channel overrides", async () => {
    await db.insert(channels).values([{ id: "C1", name: "general" }, { id: "D1", isIm: true }]);
    const res = await json(await call("PUT", "/api/settings/proactivity", { cookie: admin, body: { default: "own", channels: [{ id: "C1", mode: "quiet" }] } }));
    expect(res).toEqual({ default: "own", channels: [{ id: "C1", name: "general", mode: "quiet" }] });
    expect((await call("PUT", "/api/settings/proactivity", { cookie: admin, body: { default: "bogus" } })).status).toBe(400);
  });

  test("models list is static for the detected provider and validated on write", async () => {
    Object.assign(config, { MODEL_API_KEY: "sk-ant-x", MODEL_BASE_URL: undefined });
    const g = await json(await call("GET", "/api/settings/models", { cookie: member }));
    expect(g.provider).toBe("anthropic");
    expect(g.models.map((m: any) => m.id)).toContain("claude-sonnet-4-5");
    const ok = await call("PUT", "/api/settings/models", { cookie: admin, body: { profile: "fast", provider: "anthropic", model: "claude-haiku-4-5" } });
    expect(await json(ok)).toMatchObject({ profile: "fast", model: "claude-haiku-4-5" });
    expect((await call("PUT", "/api/settings/models", { cookie: admin, body: { profile: "fast", model: "gpt-4.1" } })).status).toBe(400);
    expect((await call("PUT", "/api/settings/models", { cookie: admin, body: { profile: "fast", provider: "openai" } })).status).toBe(400);
    Object.assign(config, { MODEL_API_KEY: undefined });
    expect((await json(await call("GET", "/api/settings/models", { cookie: member }))).provider).toBeNull();
    expect((await call("PUT", "/api/settings/models", { cookie: admin, body: { profile: "fast" } })).status).toBe(400);
  });
});

describe("skills", () => {
  test("org skills: admin-managed, versioned; personal skills: yours only; errors mapped", async () => {
    const created = await call("POST", "/api/skills", { cookie: admin, body: { name: "Standup", description: "daily", body: "do the thing", scope: "org" } });
    expect(created.status).toBe(201);
    const { id, version } = await json(created);
    expect((await call("POST", "/api/skills", { cookie: admin, body: { name: "standup", description: "d", body: "b", scope: "org" } })).status).toBe(409);
    // members cannot create or change org skills
    expect((await call("POST", "/api/skills", { cookie: member, body: { name: "Other", description: "d", body: "b", scope: "org" } })).status).toBe(403);
    expect((await call("PUT", `/api/skills/${id}`, { cookie: member, body: { enabled: true, expectedVersion: version } })).status).toBe(403);
    expect((await call("DELETE", `/api/skills/${id}`, { cookie: member })).status).toBe(403);
    // optimistic lock
    expect((await call("PUT", `/api/skills/${id}`, { cookie: admin, body: { enabled: false } })).status).toBe(400);
    expect((await call("PUT", `/api/skills/${id}`, { cookie: admin, body: { enabled: false, expectedVersion: version } })).status).toBe(200);
    const stale = await call("PUT", `/api/skills/${id}`, { cookie: admin, body: { enabled: true, expectedVersion: version } });
    expect(stale.status).toBe(409);
    expect((await json(await call("GET", "/api/skills", { cookie: member }))).map((s: any) => s.enabled)).toEqual([false]);
    expect((await call("PUT", "/api/skills/missing", { cookie: admin, body: { enabled: true, expectedVersion: 1 } })).status).toBe(404);
    expect((await call("DELETE", `/api/skills/${id}`, { cookie: admin })).status).toBe(200);
    expect((await call("DELETE", `/api/skills/${id}`, { cookie: admin })).status).toBe(404);
  });

  test("personal skills are invisible and untouchable to other members", async () => {
    const mine = await call("POST", "/api/skills", { cookie: member, body: { name: "Mine", description: "d", body: "b" } });
    expect(mine.status).toBe(201);
    const { id } = await json(mine);
    expect((await json(await call("GET", "/api/skills", { cookie: member }))).map((s: any) => s.id)).toEqual([id]);
    expect((await json(await call("GET", "/api/skills", { cookie: admin }))).map((s: any) => s.id)).toEqual([]);
    expect((await call("DELETE", `/api/skills/${id}`, { cookie: admin })).status).toBe(404);
  });
});

describe("automations", () => {
  test("members manage only their own; admins see all", async () => {
    const mk = (cookie: string) => call("POST", "/api/automations", { cookie, body: { kind: "digest", prompt: "weekly summary", cron: "0 9 * * 1" } });
    const mine = await mk(member);
    expect(mine.status).toBe(201);
    const { id } = await json(mine);
    const other = await login("M2", "member");
    expect((await json(await call("GET", "/api/automations", { cookie: other }))).length).toBe(0);
    expect((await call("PATCH", `/api/automations/${id}`, { cookie: other, body: { enabled: false } })).status).toBe(403);
    expect((await json(await call("GET", "/api/automations", { cookie: admin }))).length).toBe(1);
    expect((await call("POST", "/api/automations", { cookie: member, body: { kind: "digest", prompt: "x", cron: "* * * * *" } })).status).toBe(400); // interval too short
    expect((await call("POST", `/api/automations/${id}/run`, { cookie: other })).status).toBe(404);
    expect((await call("DELETE", `/api/automations/${id}`, { cookie: member })).status).toBe(200);
  });
});

describe("mcp connections", () => {
  test("presets listed; org scope needs admin; others' connections are off limits", async () => {
    const presets = await json(await call("GET", "/api/mcp/presets", { cookie: member }));
    expect(presets.map((p: any) => p.key)).toContain("github");
    expect((await call("POST", "/api/mcp/connections", { cookie: member, body: { provider: "github", scope: "org" } })).status).toBe(403);
    const mine = await call("POST", "/api/mcp/connections", { cookie: member, body: { provider: "linear", scope: "user" } });
    expect(mine.status).toBe(201);
    const conn = await json(mine);
    expect(conn).not.toHaveProperty("authEnc");
    await mkUser("M3", "member");
    const other = await login("M4", "member");
    expect((await call("POST", `/api/mcp/connections/${conn.id}/connect`, { cookie: other })).status).toBe(403);
    expect((await call("DELETE", `/api/mcp/connections/${conn.id}`, { cookie: other })).status).toBe(403);
    expect((await json(await call("GET", "/api/mcp/connections", { cookie: other }))).length).toBe(0);
    expect((await call("DELETE", `/api/mcp/connections/${conn.id}`, { cookie: member })).status).toBe(200);
    expect((await call("DELETE", `/api/mcp/connections/${conn.id}`, { cookie: member })).status).toBe(404);
  });
});

describe("static web", () => {
  test("serves assets, SPA fallback, blocks traversal, and leaves api/auth paths alone", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/web-`);
    writeFileSync(`${dir}/index.html`, "<html>spa</html>");
    mkdirSync(`${dir}/assets`);
    writeFileSync(`${dir}/assets/app.js`, "console.log(1)");
    process.env.WEB_DIST = dir;
    try {
      expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)");
      expect(await (await app.request("/graph")).text()).toBe("<html>spa</html>");
      expect((await app.request("/..%2f..%2fetc/passwd")).status).not.toBe(200);
      expect((await app.request("/api/unknown")).status).toBe(404);
      expect((await app.request("/slack/unknown")).headers.get("content-type")).toContain("json");
    } finally { delete process.env.WEB_DIST; }
  });
});

describe("extension upload", () => {
  test("rejects bad tokens and bodies", async () => {
    expect((await app.request("/ext/meetings", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/ext/ping", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  test("live ask/analyze need a token and a valid body", async () => {
    const post = (path: string, headers: Record<string, string>, b: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    expect((await post("/ext/ask", {}, { lines: [], question: "x" })).status).toBe(401);
    expect((await post("/ext/analyze", {}, { lines: [] })).status).toBe(401);
    const tok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } }));
    const auth = { authorization: `Bearer ${tok.token}` };
    expect((await post("/ext/ask", auth, { lines: [], question: "x" })).status).toBe(400);
    expect((await post("/ext/notes", {}, { lines: [{ speaker: "A", text: "hi" }] })).status).toBe(401);
    expect((await post("/ext/notes", auth, { lines: [] })).status).toBe(400);
    expect((await post("/ext/notes", auth, { lines: [{ speaker: "A", text: "hi" }], offset: 3, previous: "- x" })).status).not.toBe(401);
    expect((await post("/ext/analyze", auth, { lines: [{ speaker: "A", text: "hi" }], context: { roster: ["A"] }, known: [] })).status).not.toBe(401);
  });

  test("stores an upload privately for its owner", async () => {
    const tok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } }));
    const body = { externalId: "abc", platform: "meet", title: "Standup", lines: [{ speaker: "Ana", text: "Ship it Friday." }] };
    const post = (b: unknown) => app.request("/ext/meetings", { method: "POST", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", "x-wait": "1" }, body: JSON.stringify(b) });
    expect((await post({ ...body, lines: [] })).status).toBe(400);
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(201); // same externalId replaces, not duplicates
    const mine = await json(await call("GET", "/api/meetings", { cookie: admin }));
    expect(mine.filter((m: any) => m.platform === "meet")).toHaveLength(1);
    expect(await json(await call("GET", "/api/meetings", { cookie: member }))).toHaveLength(0);
  });

  test("final pass builds decisions and tasks from the whole transcript and drops anything it cannot quote", async () => {
    setMemoryLlm(async () => JSON.stringify({
      summary: "Planned the launch.",
      decisions: [
        { text: "Launch on Friday", quote: "we decided to launch on Friday" },
        { text: "Build the frontend AI integration", quote: "let's build the frontend AI integration" }, // never said
      ],
      tasks: [
        { title: "Run the advertisement campaign", description: "", assigneeName: "Parag", assigneeId: null, dueDate: null, quote: "advertisement will be done by Parag" },
        { title: "Send the deck", description: "", assigneeName: "Rahul", assigneeId: null, dueDate: null, quote: "Bob sends the deck" }, // Rahul was not on the call
        { title: "Integrate the frontend AI", description: "", assigneeName: "Bob", assigneeId: null, dueDate: null, quote: "frontend AI integration will be done" }, // never said
      ],
    }));
    try {
      const tok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } }));
      const res = await app.request("/ext/meetings", {
        method: "POST", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", "x-wait": "1" },
        body: JSON.stringify({ externalId: "fin", platform: "meet", title: "Planning", participants: ["Ana", "Bob", "Parag"],
          lines: [{ speaker: "Ana", text: "we decided to launch on Friday." }, { speaker: "Ana", text: "The advertisement will be done by Parag." }, { speaker: "Bob", text: "Bob sends the deck, fine." }] }),
      });
      const m = await json(await call("GET", `/api/meetings/${(await json(res)).id}`, { cookie: admin }));
      expect(m.status).toBe("ready");
      expect(m.decisions).toEqual(["Launch on Friday"]);
      expect(m.tasks.map((t: any) => [t.title, t.assigneeName])).toEqual([["Run the advertisement campaign", "Parag"], ["Send the deck", null]]);
      expect(m.tasks[0].description).toContain("advertisement will be done by Parag");
      // A model's guess at an owner must never message a real person on its own.
      expect((await db.select().from(meetingTaskNotifications)).length).toBe(0);
    } finally { setMemoryLlm(null); }
  });

  test("an upload with oversized or empty fields is cleaned, not rejected, and replies before the model finishes", async () => {
    const tok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } }));
    const res = await app.request("/ext/meetings", {
      method: "POST", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", "x-wait": "1" },
      body: JSON.stringify({ externalId: "big", platform: "meet", title: "x".repeat(500), participants: ["P".repeat(400), ""],
        lines: [{ speaker: "S".repeat(300), text: "hello" }, { speaker: "A", text: "   " }] }),
    });
    expect(res.status).toBe(201);
    const m = await json(await call("GET", `/api/meetings/${(await json(res)).id}`, { cookie: admin }));
    expect(m.title.length).toBe(240);
    const own = await json(await app.request(`/ext/meetings/${m.id}`, { headers: { authorization: `Bearer ${tok.token}` } }));
    expect(own.id).toBe(m.id);
    const other = await json(await call("POST", "/api/tokens", { cookie: member, body: { name: "x" } })); // members cannot mint tokens
    expect(other.error).toBeDefined();
  });

  test("a member makes their own extension token, sees their uploads, and the token cannot open the MCP server", async () => {
    const minted = await call("POST", "/api/meetings/extension-token", { cookie: member });
    expect(minted.status).toBe(201);
    const { token } = await json(minted);
    const auth = { authorization: `Bearer ${token}` };
    const up = await app.request("/ext/meetings", { method: "POST", headers: { ...auth, "content-type": "application/json", "x-wait": "1" }, body: JSON.stringify({ externalId: "m1", platform: "meet", title: "Member call", lines: [{ speaker: "M", text: "hello there" }] }) });
    expect(up.status).toBe(201);
    const mine = await json(await call("GET", "/api/meetings", { cookie: member }));
    expect(mine.map((m: any) => m.title)).toEqual(["Member call"]); // the person using the extension sees it
    expect((await app.request("/ext/ping", { headers: auth })).status).toBe(200);
    expect((await app.request("/mcp", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status).toBe(401); // extension-only
    // an admin's older API token still serves the extension, but its uploads belong to the admin
    const adminTok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "old" } }));
    expect((await app.request("/ext/ping", { headers: { authorization: `Bearer ${adminTok.token}` } })).status).toBe(200);
    // a new token replaces the old one
    const again = await json(await call("POST", "/api/meetings/extension-token", { cookie: member }));
    expect((await app.request("/ext/ping", { headers: auth })).status).toBe(401);
    expect((await app.request("/ext/ping", { headers: { authorization: `Bearer ${again.token}` } })).status).toBe(200);
    expect((await call("POST", "/api/meetings/extension-token", {})).status).toBe(401); // must be signed in
  });

  test("keeps the decisions and tasks recorded in the side panel", async () => {
    const tok = await json(await call("POST", "/api/tokens", { cookie: admin, body: { name: "ext" } }));
    const res = await app.request("/ext/meetings", {
      method: "POST", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", "x-wait": "1" },
      body: JSON.stringify({ externalId: "n1", platform: "meet", title: "Planning", lines: [{ speaker: "Ana", text: "Bob sends the deck." }],
        participants: ["Ana", "Bob"], decisions: ["Launch on Friday"], tasks: [{ title: "Send the deck", assignee: "Bob", due: "Thu" }] }),
    });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    const m = await json(await call("GET", `/api/meetings/${id}`, { cookie: admin }));
    expect(m.tasks[0]).toMatchObject({ title: "Send the deck", assigneeName: "Bob", dueDate: "Thu" });
    expect(m.decisions).toContain("Launch on Friday");
  });
});

describe("meeting task DMs", () => {
  test("a meeting viewer can send a task DM once and correct an assignee", async () => {
    await mkUser("U2", "member", { name: "Max Member" });
    await db.insert(channels).values({ id: "C1", name: "general", isPrivate: false });
    await db.insert(meetings).values({
      id: "mt_dm", sourceFileId: "F_dm", channelId: "C1", title: "Planning", transcript: "Max owns this.", status: "ready",
      tasks: [{ id: "mtask_1", title: "Draft plan", description: "Write it up", assigneeName: "Max Member", assigneeId: "U2", dueDate: null }], participantIds: [],
    });
    let posted = 0;
    setSlackClientForTest({ conversations: { open: async () => ({ channel: { id: "D2" } }) }, chat: { postMessage: async () => { posted += 1; return { ts: "1.2" }; } } });
    try {
      const first = await json(await call("POST", "/api/meetings/mt_dm/task-dms", { cookie: member }));
      expect(first).toMatchObject({ sent: 1, failed: 0 });
      expect(posted).toBe(1);
      const again = await json(await call("POST", "/api/meetings/mt_dm/task-dms", { cookie: member }));
      expect(again).toMatchObject({ sent: 0, skipped: 1 });
      expect(await db.select().from(meetingTaskNotifications)).toHaveLength(1);
      const changed = await json(await call("PATCH", "/api/meetings/mt_dm/tasks/mtask_1", { cookie: member, body: { assigneeId: "M1" } }));
      expect(changed.tasks[0]).toMatchObject({ assigneeId: "M1", assigneeName: "User M1" });
    } finally { setSlackClientForTest(null); }
  });
});
