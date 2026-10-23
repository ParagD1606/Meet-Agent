import type { Hono } from "hono";
import { log } from "../log";
import { handleOAuthCallback } from "./connections";

export { PRESETS, getPreset, type Preset } from "./catalog";
export { classifyTool } from "./policy";
export * from "./connections";

const page = (title: string, body: string, status: 200 | 400 = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>${title}</h2><p>${body}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  });

export function mountMcp(app: Hono): void {
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
