import type { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { createConnection, deleteConnection, listConnections, startConnect } from "../mcp/connections";
import { getMarketItem, searchDirectory, validateCustomMcpUrl, type MarketItem } from "../mcp/directory";
import { httpError, readBody, readQuery } from "./util";

const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();

/**
 * Connector marketplace.
 *  GET  /marketplace?q=&limit=             ranked apps with `connected` flags for the caller
 *  POST /marketplace/:key/install          {scope?: "user"|"org", token?}  -> {connection, authUrl?}
 *  POST /marketplace/custom/install        {url, label?, scope?, token?}   (any public https MCP server)
 * OAuth apps return `authUrl` to open; API-key apps require `token`. Org installs need admin.
 */
export function mountMarketplaceRoutes(api: Hono<AppEnv>): void {
  api.get("/marketplace", requireAuth(), async (c) => {
    const { q, limit } = readQuery(c, z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }));
    const u = c.get("user");
    const r = searchDirectory(q ?? "", limit ?? 50);
    const conns = (await listConnections(u.id, u.role)).filter((x) => x.status === "connected");
    const connected = (m: MarketItem) => conns.some((x) => (m.curated ? x.provider === m.key : norm(x.url) === norm(m.url)));
    return c.json({
      items: r.apps.map((m) => ({ key: m.key, name: m.name, url: m.url, categories: m.categories, connectMode: m.connectMode, personalOnly: m.personalOnly, iconDomain: m.iconDomain, connected: connected(m) })),
      total: r.totalMatches,
    });
  });

  api.post("/marketplace/:key/install", requireAuth(), async (c) => {
    const u = c.get("user");
    const key = c.req.param("key");
    const b = await readBody(c, z.object({
      scope: z.enum(["user", "org"]).default("user"),
      token: z.string().min(1).max(4000).optional(),
      label: z.string().trim().max(80).optional(),
      url: z.string().max(2000).optional(),
    }));
    if (b.scope === "org" && !(u.role === "admin" || u.role === "owner")) throw httpError(403, "forbidden");

    let args: { provider?: string; url?: string; label: string };
    let name: string;
    if (key === "custom") {
      if (!b.url) throw httpError(400, "invalid_body", { message: "url required" });
      const v = await validateCustomMcpUrl(b.url);
      if (!v.ok) throw httpError(400, "invalid_url", { message: v.error });
      name = b.label || new URL(v.url).hostname;
      args = { url: v.url, label: name };
    } else {
      const item = getMarketItem(key);
      if (!item) throw httpError(404, "not_found");
      if (item.personalOnly && b.scope === "org") throw httpError(400, "personal_only", { message: `${item.name} can only be connected personally` });
      if (item.connectMode === "apikey" && !b.token) throw httpError(400, "token_required", { message: `${item.name} needs an API key` });
      name = item.name;
      args = item.curated ? { provider: item.key, label: b.label || name } : { url: item.url, label: b.label || name };
    }
    let conn;
    try {
      conn = await createConnection({ ...args, scope: b.scope, ownerUserId: b.scope === "user" ? u.id : null, token: b.token });
    } catch (e) {
      throw httpError(400, "invalid_connection", { message: e instanceof Error ? e.message : String(e) });
    }
    if (b.token) return c.json({ connection: conn }, 201);
    try {
      return c.json({ connection: conn, ...(await startConnect(conn.id)) }, 201);
    } catch (e) {
      await deleteConnection(conn.id, u.id).catch(() => {}); // don't leave a dead pending row behind
      throw httpError(502, "connect_failed", { message: e instanceof Error ? e.message : String(e) });
    }
  });
}
