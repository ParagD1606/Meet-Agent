import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { connectSession, setMcpFactory } from "../../src/mcp/client";
import { readAuth } from "../../src/mcp/oauth";

export type FakeCall = { tool: string; args: Record<string, unknown>; auth: string };
export type FakeMode = "ok" | "reauth" | "down";

/** In-process HTTP MCP server that mimics Notion's tool surface (reads, writes, destructive, calendar) over the real protocol. */
export async function startFakeMcp() {
  const calls: FakeCall[] = [];
  const state = { mode: "ok" as FakeMode, boom: false, token: "good" };
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
  const build = (auth: string) => {
    const s = new McpServer({ name: "fake-notion", version: "1.0.0" });
    const def = (name: string, description: string, shape: z.ZodRawShape, annotations: Record<string, boolean>, fn: (a: any) => string) =>
      s.registerTool(name, { description, inputSchema: shape, annotations }, async (a: any) => {
        calls.push({ tool: name, args: a, auth });
        if (state.boom && name === "notion-create-pages") return text("validation_error: parent.page_id is required", true);
        return text(fn(a));
      });
    def("notion-search", "Search Notion pages and databases by query.", { query: z.string() }, { readOnlyHint: true }, (a) => `results for ${a.query}: [Roadmap](page_1)`);
    def("notion-fetch", "Fetch a Notion page by id.", { id: z.string() }, { readOnlyHint: true }, (a) => `page ${a.id}: hello`);
    def("notion-create-pages", "Create one or more Notion pages.", { pages: z.array(z.object({ title: z.string() })), parent: z.string().optional() }, { readOnlyHint: false, destructiveHint: false }, (a) => `created ${a.pages.length} page(s): https://notion.so/new`);
    def("notion-update-page", "Update a Notion page's properties or content.", { page_id: z.string(), content: z.string().optional() }, { readOnlyHint: false, destructiveHint: false }, (a) => `updated ${a.page_id}`);
    def("notion-create-view", "Create a database view.", { database_id: z.string() }, { readOnlyHint: false, destructiveHint: true }, () => "view created");
    def("notion-delete-comment", "Delete a comment.", { comment_id: z.string() }, { readOnlyHint: false, destructiveHint: true }, () => "deleted");
    def("notion-calendar-create-events", "Create calendar events.", { title: z.string(), start: z.string() }, { readOnlyHint: false, destructiveHint: true }, (a) => `event ${a.title}`);
    for (const n of ["get-users", "get-teams", "get-comments", "list-databases", "get-self", "list-views", "get-page-history", "list-templates", "get-workspace"])
      def(`notion-${n}`, `Read ${n.replace(/-/g, " ")} from Notion.`, {}, { readOnlyHint: true }, () => `${n}: []`);
    return s;
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      if (state.mode === "down") return new Response("bad gateway", { status: 502 });
      if (state.mode === "reauth" || auth !== `Bearer ${state.token}`) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="fake"' } });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = build(auth);
      await mcp.connect(transport);
      try { return await transport.handleRequest(req); } finally { await mcp.close().catch(() => {}); }
    },
  });
  const url = `http://localhost:${server.port}/mcp`;
  /** Routes every connection (preset URLs included) to this server, speaking real MCP with the stored bearer token. */
  setMcpFactory(async (conn) => {
    const a = await readAuth(conn.id);
    return connectSession(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${a.accessToken ?? ""}` } } }));
  });
  return { url, calls, state, stop: () => { server.stop(true); setMcpFactory(); } };
}
