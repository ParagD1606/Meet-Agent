import "../turn/env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { invalidateApprovalCards } from "../../src/mcp/policy";
import { createConnection } from "../../src/mcp/connections";
import { setOrgWrites } from "../../src/mcp/writes";
import { setMcpFactory, type McpToolInfo } from "../../src/mcp/client";
import { buildMcpTools, minSchema, toolKey, type McpToolCtx } from "../../src/mcp/tools";
import { rankTools, shortDesc } from "../../src/mcp/tool-search";
import { minifyResult, project, capResult, setSpillForTest, MCP_PREVIEW_CHARS } from "../../src/mcp/minify";
import { setResolver } from "../../src/tools/web/ssrf";
import { fakeSlack, seedTurn, seedUsers } from "../turn/helpers";

const ctx = (over: Partial<McpToolCtx> = {}): McpToolCtx => ({ turnId: "turn1", userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false, ...over });
const run = async (tools: any, name: string, input: any = {}) => tools[name].execute(input, { toolCallId: "x", messages: [] });
const T = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = []): McpToolInfo =>
  ({ name, description, inputSchema: { type: "object", properties: props, required } });

const BIG: McpToolInfo[] = [
  T("list_issues", "List issues in a repository. Supports filters.", { repo: { type: "string" } }, ["repo"]),
  T("get_issue", "Get a single issue by number", { repo: { type: "string" }, number: { type: "number" } }, ["repo", "number"]),
  T("search_code", "Search source code across repositories"),
  T("create_issue", "Create a new issue", { title: { type: "string" } }, ["title"]),
  T("list_pull_requests", "List pull requests"),
  T("merge_pull_request", "Merge a pull request"),
  ...Array.from({ length: 10 }, (_, i) => T(`get_thing_${i}`, `Get thing number ${i} from the widget service`)),
];

let calls: { connectionId: string; name: string; args: any }[];
let text = (n: string) => `ok:${n}`;
function mcp(tools: McpToolInfo[], over: { callTool?: (n: string, a: any) => Promise<any> } = {}) {
  calls = [];
  setMcpFactory(async (conn) => ({
    listTools: async () => tools,
    callTool: over.callTool ?? (async (name, args) => { calls.push({ connectionId: conn.id, name, args }); return { content: [{ type: "text", text: text(name) }] }; }),
    close: async () => {},
  }));
}
beforeEach(async () => {
  setResolver(async () => ["93.184.216.34"]);
  await resetDb(); invalidateApprovalCards(); await seedUsers(); await seedTurn(); fakeSlack(); setSpillForTest(null); text = (n) => `ok:${n}`;
});

describe("lazy tool threshold", () => {
  test("small apps are listed; apps above the threshold are reached via search_tools/call_tool only", async () => {
    mcp(BIG);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const small = await buildMcpTools(ctx({ lazyThreshold: 50 }));
    expect(Object.keys(small.tools)).toContain("github__list_issues");
    expect(small.tools.search_tools).toBeUndefined();
    const lazy = await buildMcpTools(ctx());
    expect(Object.keys(lazy.tools).sort()).toEqual(["call_tool", "search_tools"]);
  });

  test("lazy path: search finds the tool, call_tool runs reads, destructive writes only post approvals, unknown names are structured errors", async () => {
    mcp(BIG);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    const found = String(await run(tools, "search_tools", { query: "list issues" }));
    expect(found.split("\n")[0]).toContain("github__list_issues(repo*)");
    expect(await run(tools, "call_tool", { name: "github__list_issues", args: { repo: "a/b" } })).toBe("ok:list_issues");
    expect(calls).toEqual([{ connectionId: expect.any(String), name: "list_issues", args: { repo: "a/b" } }]);
    expect((await run(tools, "call_tool", { name: "github__list_issues" })).kind).toBe("invalid_input"); // missing required
    expect((await run(tools, "call_tool", { name: "nope" })).kind).toBe("not_found");
    // the read above fed app data into this turn (untrusted), so a ticket write on THIS turn is carded; a clean turn is not
    expect((await run(tools, "call_tool", { name: "github__create_issue", args: { title: "x" } })).status).toBe("awaiting_approval");
    expect(await run((await buildMcpTools(ctx())).tools, "call_tool", { name: "github__create_issue", args: { title: "x" } })).toBe("ok:create_issue"); // ticket write on a clean turn: no card by default
    const w = await run(tools, "call_tool", { name: "github__merge_pull_request", args: {} });
    expect(w.status).toBe("awaiting_approval");
    expect(calls).toHaveLength(2);
  });

  test("lazy tools respect scope rules: org-only providers hide writes, readOnly turns hide them everywhere", async () => {
    mcp(BIG);
    await setOrgWrites(false);
    await createConnection({ provider: "github", scope: "org", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    const all = String(await run(tools, "search_tools", { query: "issue pull request", limit: 15 }));
    expect(all).not.toContain("create_issue");
    expect(all).not.toContain("merge_pull_request");
    expect((await run(tools, "call_tool", { name: "github__create_issue", args: { title: "x" } })).kind).toBe("not_found");
  });

  test("lazy tool schemas stay tiny", async () => {
    mcp(BIG);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    expect(JSON.stringify(Object.values(tools).map((t: any) => [t.description, t.inputSchema?.jsonSchema ?? "z"])).length).toBeLessThan(1500);
  });
});

describe("tool-search ranking", () => {
  const items = BIG.map((info) => ({ info }));
  test("name hits beat description hits and plural/stem match", () => {
    expect(rankTools("issues", items, 3).map((r) => r.info.name).sort()).toEqual(["create_issue", "get_issue", "list_issues"]);
    expect(rankTools("list issues", items)[0]!.info.name).toBe("list_issues");
    expect(rankTools("merge", items)[0]!.info.name).toBe("merge_pull_request");
    expect(rankTools("source code", items)[0]!.info.name).toBe("search_code");
    expect(rankTools("zzz", items)).toEqual([]);
    expect(rankTools("widget", items, 3)).toHaveLength(3);
  });
  test("shortDesc keeps the first sentence and caps length", () => {
    expect(shortDesc("List issues. Supports many filters and more.")).toBe("List issues.");
    expect(shortDesc("x".repeat(300)).length).toBe(110);
  });
});

describe("name keys", () => {
  test("long names are truncated with a connection-specific hash and never collide", () => {
    const used = new Set<string>();
    const long = "a_very_long_tool_name_".repeat(5);
    const k1 = toolKey({ id: "c1", provider: "github", url: "https://x" }, long, used);
    const k2 = toolKey({ id: "c2", provider: "github", url: "https://x" }, long + "2", used);
    expect(k1.length).toBeLessThanOrEqual(64);
    expect(k2.length).toBeLessThanOrEqual(64);
    expect(k1).not.toBe(k2);
    const k3 = toolKey({ id: "c3", provider: "github", url: "https://x" }, "x", used);
    const k4 = toolKey({ id: "c4", provider: "github", url: "https://x" }, "x", used);
    expect(k3).toBe("github__x");
    expect(k4).not.toBe(k3); // same name from another connection gets a suffix
  });

  test("two custom MCP servers keep separate tools instead of overwriting each other", async () => {
    mcp([T("list_things", "List things")]);
    const a = await createConnection({ url: "https://mcp.alpha-example.com/mcp", scope: "org", token: "t" });
    const b = await createConnection({ url: "https://mcp.beta-example.com/mcp", scope: "org", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    expect(Object.keys(tools).sort()).toEqual(["alpha_example_com__list_things", "beta_example_com__list_things"]);
    await run(tools, "beta_example_com__list_things");
    expect(calls[0]!.connectionId).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  test("minSchema drops decoration and caps descriptions", () => {
    const s: any = minSchema({ $schema: "x", title: "T", additionalProperties: false, type: "object", properties: { a: { type: "string", description: "d ".repeat(200), title: "A" } } });
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBeUndefined();
    expect(s.properties.a.title).toBeUndefined();
    expect(s.properties.a.description.length).toBeLessThanOrEqual(100);
  });
});

describe("output diet", () => {
  test("minify drops nulls, empties, api-url metadata and HTML; keeps html_url", () => {
    const out = JSON.parse(minifyResult(JSON.stringify([{ id: 1, title: "A", body: null, labels: [], node_id: "x", url: "https://api/x", html_url: "https://h/1", avatar_url: "u", owner: { gravatar_id: "", login: "me" }, text: "<p>Hello <b>world</b></p>", draft: false }])));
    expect(out).toEqual([{ id: 1, title: "A", url: "https://api/x", html_url: "https://h/1", owner: { login: "me" }, text: "Hello world", draft: false }]);
    expect(minifyResult(" plain text ")).toBe("plain text");
  });

  test("projection keeps only requested paths, maps over arrays, unwraps a single-array envelope", () => {
    const data = { total: 2, items: [{ id: 1, user: { login: "a", id: 9 }, body: "long" }, { id: 2, user: { login: "b", id: 8 }, body: "long" }] };
    expect(project(data, ["id", "user.login"])).toEqual([{ id: 1, user: { login: "a" } }, { id: 2, user: { login: "b" } }]);
    expect(JSON.parse(minifyResult(JSON.stringify(data), { fields: ["id"] }))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("big results spill when spill exists, else are truncated with an explicit note; small ones pass untouched", async () => {
    const big = "x".repeat(MCP_PREVIEW_CHARS + 500);
    expect(await capResult("small", { turnId: "t", toolName: "n" })).toBe("small");
    expect(await capResult(big, { turnId: "t", toolName: "n" })).toBe(big); // no spill module: under fallback cap
    const huge = "y".repeat(20_000);
    expect(await capResult(huge, { turnId: "t", toolName: "n" })).toContain("[truncated: 12000 more chars");
    let seen: any;
    setSpillForTest(async (a) => { seen = a; return "preview+handle"; });
    expect(await capResult(big, { turnId: "turn1", toolName: "gh" })).toBe("preview+handle");
    expect(seen).toMatchObject({ turnId: "turn1", toolName: "gh", maxChars: MCP_PREVIEW_CHARS });
  });

  test("tool output goes through minify+spill end to end, with fields on call_tool", async () => {
    text = () => JSON.stringify([{ id: 1, title: "A", body: null, node_id: "n" }]);
    mcp(BIG);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    expect(await run(tools, "call_tool", { name: "github__list_pull_requests" })).toBe('[{"id":1,"title":"A"}]');
    expect(await run(tools, "call_tool", { name: "github__list_pull_requests", fields: ["title"] })).toBe('[{"title":"A"}]');
  });
});
afterAll(() => setResolver());
