import { tool, type ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { log } from "../log";
import { getSlack } from "../turn/slack";
import { createConnection, type PublicConnection } from "./connections";
import { getMarketItem, MARKET, searchDirectory, type MarketItem } from "./directory";

const base = () => config.PUBLIC_URL.replace(/\/$/, "");
export const connectLandingUrl = (connectionId: string) => `${base()}/mcp-connect/${connectionId}`;
export const integrationsUrl = (key?: string) => `${base()}/configure/integrations${key ? `?connect=${encodeURIComponent(key)}` : ""}`;

/** Reuses the user's unfinished connection for this app, else creates a pending personal one. Throws if already connected. */
export async function ensureUserConnection(item: MarketItem, userId: string): Promise<PublicConnection> {
  const mine = await db.select().from(mcpConnections).where(and(eq(mcpConnections.ownerUserId, userId), eq(mcpConnections.scope, "user")));
  const same = mine.filter((c) => (item.curated ? c.provider === item.key : c.url.replace(/\/+$/, "").toLowerCase() === item.url.replace(/\/+$/, "").toLowerCase()));
  if (same.some((c) => c.status === "connected")) throw new Error(`${item.name} is already connected`);
  const stale = same[0];
  if (stale) { const { authEnc: _a, ...pub } = stale; return pub; }
  return createConnection({ provider: item.curated ? item.key : undefined, url: item.curated ? undefined : item.url, label: item.name, scope: "user", ownerUserId: userId });
}

type Ctx = { userId: string | null; channelId: string; threadTs?: string; readOnly: boolean; orgConnectionsOnly: boolean };

/**
 * `search_mcp_directory` (always safe, read-only) and `connect_app` (posts a private Connect button).
 * Registered for members' own turns only: no button for automations / read-only / org-only turns.
 */
export function directoryTools(ctx: Ctx): ToolSet {
  const out: ToolSet = {
    search_mcp_directory: tool({
      description: `Search ${MARKET.length} apps this workspace can connect (beyond those already connected). Finding one means it CAN be connected, not that it is. Pass its key to connect_app. If truncated, say more exist.`,
      inputSchema: z.object({ query: z.string().max(100).describe("App name or capability, e.g. 'figma' or 'design'") }),
      execute: async ({ query }) => {
        const r = searchDirectory(query);
        return {
          apps: r.apps.map((a) => ({ key: a.key, name: a.name, categories: a.categories, connectMode: a.connectMode })),
          totalMatches: r.totalMatches, truncated: r.truncated,
        };
      },
    }),
  };
  if (ctx.readOnly || ctx.orgConnectionsOnly || !ctx.userId) return out;
  const userId = ctx.userId;
  out.connect_app = tool({
    description: "Post a private Connect button so the requester can connect an app (key from search_mcp_directory or a preset like github). Then stop and wait; they ask again once connected.",
    inputSchema: z.object({ key: z.string().min(1).max(80) }),
    execute: async ({ key }) => {
      const item = getMarketItem(key);
      if (!item) return { status: "error", message: `Unknown app "${key}". Use search_mcp_directory first.` };
      if (item.connectMode === "apikey") {
        return { status: "needs_key", message: `${item.name} uses an API key, which only the user can enter.`, setupUrl: integrationsUrl(item.key) };
      }
      let conn: PublicConnection;
      try { conn = await ensureUserConnection(item, userId); }
      catch (e) { return { status: "error", message: e instanceof Error ? e.message : String(e) }; }
      try {
        const slack = await getSlack();
        await slack.chat.postEphemeral({
          channel: ctx.channelId, user: userId, thread_ts: ctx.threadTs, text: `Connect ${item.name}`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${item.name.replace(/[<>&]/g, "")}*\nOnly you see this. Connects your own account; disconnect any time.` } },
            { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Connect" }, action_id: `mcp_connect_${item.key}`.slice(0, 255), url: connectLandingUrl(conn.id) }] },
          ],
        });
        return { status: "button_posted", message: `A private Connect button for ${item.name} was shown to the user. Tell them to click it, then stop.` };
      } catch (e) {
        log.warn("connect_app ephemeral failed", { error: String(e) });
        return { status: "error", message: "Could not show a private button here.", setupUrl: integrationsUrl(item.key) };
      }
    },
  });
  return out;
}
