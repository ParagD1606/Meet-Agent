import type { Hono } from "hono";
import { log } from "../log";
import { userFromRequest } from "../auth/session";
import { getConnection, handleOAuthCallback, startConnect } from "./connections";
import { finishGithubConnect } from "./github";

export { PRESETS, getPreset, type Preset } from "./catalog";
export { classifyTool } from "./policy";
export * from "./connections";
export { searchDirectory, getMarketItem, MARKET, validateCustomMcpUrl } from "./directory";
export { directoryTools, ensureUserConnection } from "./directory-tool";
export { buildMcpTools, type McpToolCtx } from "./tools";
export { requesterLacksPersonalAppAccess, teammateAccessTools } from "./access-intent";

const page = (title: string, body: string, status: 200 | 400 | 401 | 404 | 502 = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>${title}</h2><p>${body}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  });

export function mountMcp(app: Hono): void {
  app.get("/github/oauth/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (error || !code || !state) return page("GitHub connection failed", "GitHub did not return an authorization code.", 400);
    const user = await userFromRequest(c);
    if (!user) return page("Sign in first", `Sign in to Company Brain with Slack at <a href="/auth/slack">/auth/slack</a>, then connect GitHub again.`, 401);
    try {
      const { label } = await finishGithubConnect(code, state, user.id);
      return page("GitHub connected", `${label.replace(/[<>&]/g, "")} is now connected. You can close this tab.`);
    } catch (e) {
      log.warn("github oauth callback error", { error: String(e) });
      return page("GitHub connection failed", "Could not complete the GitHub connection. Please try again from Integrations.", 400);
    }
  });
  app.get("/mcp-oauth/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (error || !code || !state) return page("Connection failed", "The provider did not return an authorization code.", 400);
    try {
      const { label } = await handleOAuthCallback(code, state);
      return page("Connected", `${label.replace(/[<>&]/g, "")} is now connected. You can close this tab.`);
    } catch (e) {
      log.warn("mcp oauth callback error", { error: String(e) });
      return page("Connection failed", "Could not complete the connection. Please try again from Company Brain.", 400);
    }
  });
}

/**
 * Landing for the Slack "Connect" button: `GET /mcp-connect/:id`. Only the signed-in owner of the pending
 * personal connection is forwarded to the provider's consent screen; everyone else sees the same neutral 404.
 */
export function mountMcpConnect(app: Hono<any>): void {
  app.get("/mcp-connect/:id", async (c) => {
    const user = await userFromRequest(c);
    if (!user) return page("Sign in first", `Sign in to Company Brain with Slack at <a href="/auth/slack">/auth/slack</a>, then click the Connect button in Slack again.`, 401);
    const conn = await getConnection(c.req.param("id"));
    if (!conn || conn.scope !== "user" || conn.ownerUserId !== user.id) return page("Link not valid", "This connect link is not valid for your account.", 404);
    if (conn.status === "connected") return page("Already connected", `${conn.label.replace(/[<>&]/g, "")} is already connected. You can close this tab.`);
    try {
      const { authUrl } = await startConnect(conn.id);
      return c.redirect(authUrl, 302);
    } catch (e) {
      log.warn("mcp connect landing failed", { connection: conn.id, error: String(e) });
      return page("Connection failed", "Could not start the connection. Try again from Integrations.", 502);
    }
  });
}
