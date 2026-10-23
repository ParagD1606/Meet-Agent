import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { sha256 } from "../crypto";
import { db } from "../db";
import { apiTokens, memories, users } from "../db/schema";
import { checkRate } from "../limits/rate";
import { log, redactError } from "../log";
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
        .where(and(eq(memories.scopeTag, "shared"), eq(memories.status, "active"), eq(memories.reviewState, "ok"), isNull(memories.invalidAt)))
        .orderBy(desc(memories.createdAt), desc(memories.id))
        .limit(limit ?? 20);
      if (!rows.length) return text("No memories yet.");
      return text(rows.map((r) => `[${r.id}] ${r.createdAt.toISOString()} (${r.source}) ${r.text}`).join("\n\n"));
    },
  );
  return server;
}

/** API tokens expire a year after creation (api_tokens has no explicit expiry column). */
export const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;

/** Returns the token owner's id for a valid, unexpired, non-deactivated bearer token. */
export async function authenticateToken(header: string | undefined): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  const [row] = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.hash, sha256(m[1]!)), eq(users.deactivated, false), gt(apiTokens.createdAt, new Date(Date.now() - TOKEN_TTL_MS))))
    .limit(1);
  return row?.userId ?? null;
}

export function mountMcpServer(app: Hono<any>): void {
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, use POST)" }, id: null }, 405));
  app.post("/mcp", async (c) => {
    const userId = await authenticateToken(c.req.header("authorization"));
    if (!userId) return c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="company-brain"' });
    const rate = await checkRate({ userId, channelId: "mcp-server", kind: "mcp" });
    if (!rate.ok) return c.json({ error: "rate_limited", message: rate.message }, 429, { "retry-after": String(rate.retryAfterSec) });
    // Stateless: a fresh server+transport per request, JSON responses.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer();
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (e) {
      log.warn("mcp server request failed", { err: redactError(e) });
      return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }, 500);
    } finally {
      await server.close().catch(() => {});
    }
  });
}
