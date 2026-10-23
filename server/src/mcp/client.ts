import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { log } from "../log";
import { assertPublicUrl, guardedFetch } from "../tools/web/ssrf";
import { getPreset } from "./catalog";
import { AuthDecryptError, DbOAuthProvider, McpReauthRequired, readAuth } from "./oauth";

export type ConnectionRow = typeof mcpConnections.$inferSelect;
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
export type McpSession = {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};
export type McpFactory = (conn: ConnectionRow) => Promise<McpSession>;

const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;

async function realFactory(conn: ConnectionRow): Promise<McpSession> {
  const preset = getPreset(conn.provider);
  if (!preset) await assertPublicUrl(conn.url); // custom URLs: SSRF guard on every connect
  const auth = await readAuth(conn.id);
  const url = new URL(conn.url);
  const transport = auth.bearer && auth.accessToken
    ? new StreamableHTTPClientTransport(url, { fetch: guardedFetch, requestInit: { headers: { authorization: `Bearer ${auth.accessToken}` } } }) // static bearer token
    : new StreamableHTTPClientTransport(url, { fetch: guardedFetch, authProvider: new DbOAuthProvider(conn.id, false) });
  const client = new Client({ name: "company-brain", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
        out.push(...(page.tools as McpToolInfo[]));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    callTool: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal: AbortSignal.timeout(CALL_TIMEOUT_MS + 5_000) }),
    close: () => client.close().catch(() => {}),
  };
}

let factory: McpFactory = realFactory;
/** Test seam: replace the network layer. Pass undefined to restore. */
export function setMcpFactory(f?: McpFactory) { factory = f ?? realFactory; toolCache.clear(); }

const toolCache = new Map<string, { at: number; tools: McpToolInfo[] }>();
const TTL = 5 * 60_000;
export const clearToolCache = (connectionId?: string) => (connectionId ? toolCache.delete(connectionId) : toolCache.clear());

async function withSession<T>(conn: ConnectionRow, fn: (s: McpSession) => Promise<T>): Promise<T> {
  let s: McpSession | undefined;
  try {
    s = await factory(conn);
    return await fn(s);
  } catch (e) {
    if (e instanceof AuthDecryptError) {
      // unreadable credentials can never work again: surface it as "needs reconnect", never as a silent unauthenticated call
      await db.update(mcpConnections).set({ status: "error" }).where(eq(mcpConnections.id, conn.id));
      toolCache.delete(conn.id);
      throw new McpReauthRequired(conn.id);
    }
    if (e instanceof McpReauthRequired || (e as Error)?.name === "UnauthorizedError") {
      await db.update(mcpConnections).set({ status: "error" }).where(eq(mcpConnections.id, conn.id));
      toolCache.delete(conn.id);
      throw new McpReauthRequired(conn.id);
    }
    throw e;
  } finally {
    await s?.close().catch((e) => log.warn("mcp close failed", { error: String(e) }));
  }
}

export async function listConnectionTools(conn: ConnectionRow): Promise<McpToolInfo[]> {
  const hit = toolCache.get(conn.id);
  if (hit && Date.now() - hit.at < TTL) return hit.tools;
  const tools = await withSession(conn, (s) => s.listTools());
  toolCache.set(conn.id, { at: Date.now(), tools });
  return tools;
}

const MAX_RESULT = 20_000;
/** Calls a tool and flattens MCP content to text. Throws on transport errors; tool-level errors come back as text prefixed "ERROR:". */
export async function callConnectionTool(conn: ConnectionRow, name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await withSession(conn, (s) => s.callTool(name, args))) as {
    content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown;
  };
  const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n")
    || (res.structuredContent ? JSON.stringify(res.structuredContent) : "");
  const out = text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "\n[truncated]" : text;
  return res.isError ? `ERROR: ${out}` : out;
}
