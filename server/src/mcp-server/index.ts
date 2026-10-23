import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { sha256 } from "../crypto";
import { db } from "../db";
import { apiTokens, memories, users } from "../db/schema";
import { log } from "../log";
import { searchMemory } from "../memory/search";

/** Outward-facing scope: API tokens only ever read the org-wide "shared" tag. */
const TAGS = ["shared"];

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "company-brain", version: "1.0.0" });
  server.registerTool(
    "search_memory",
    {
      description: "Search the company's shared memory (facts and documents) and return the best matches.",
      inputSchema: { query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, limit }) => {
      try {
        const hits = await searchMemory({ tags: TAGS, query, limit: limit ?? 10 });
        if (!hits.length) return text("No matching memories.");
        return text(hits.map((h) => `[${h.id}] (${h.source}${h.sourceRef ? `: ${h.sourceRef}` : ""}) ${h.text}`).join("\n\n"));
      } catch (e) {
        log.warn("mcp search_memory failed", { err: String(e) });
        return { ...text(`Search failed: ${e instanceof Error ? e.message : String(e)}`), isError: true };
      }
    },
  );
  server.registerTool(
    "list_recent",
    {
      description: "List the most recently added shared memories.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit }) => {
      const rows = await db
        .select({ id: memories.id, text: memories.text, source: memories.source, createdAt: memories.createdAt })
        .from(memories)
        .where(and(eq(memories.scopeTag, "shared"), eq(memories.status, "active")))
        .orderBy(desc(memories.createdAt), desc(memories.id))
        .limit(limit ?? 20);
      if (!rows.length) return text("No memories yet.");
      return text(rows.map((r) => `[${r.id}] ${r.createdAt.toISOString()} (${r.source}) ${r.text}`).join("\n\n"));
    },
  );
  return server;
}

/** Returns the token owner's id for a valid, non-deactivated bearer token. */
export async function authenticateToken(header: string | undefined): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  const [row] = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.hash, sha256(m[1]!)), eq(users.deactivated, false)))
    .limit(1);
  return row?.userId ?? null;
}

export function mountMcpServer(app: Hono<any>): void {
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, use POST)" }, id: null }, 405));
  app.post("/mcp", async (c) => {
    if (!(await authenticateToken(c.req.header("authorization")))) {
      return c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="company-brain"' });
    }
    // Stateless: a fresh server+transport per request, JSON responses.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer();
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    await server.close();
    return res;
  });
}
