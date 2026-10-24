import { resolve, sep } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mountAuth } from "../auth/slack";
import { csrf, type AppEnv } from "../auth/session";
import { mountMcpServer } from "../mcp-server";
import { mountSyncOAuth } from "../sync";
import { tuningEnv } from "../config";
import { log } from "../log";
import { limitsRoutes } from "../limits/routes";
import { mountExportRoutes } from "./export";
import { mountMarketplaceRoutes } from "./marketplace";
import { mountMemoryExtRoutes } from "./memory-ext";
import { mountSkillsUploadRoutes } from "./skills-upload";
import { behavior } from "./behavior";
import { channelRoutes } from "./channels";
import { core } from "./core";
import { memory } from "./memory";
import { memoryRun } from "./memory-run";
import { extensionRoutes, meetingRoutes } from "./meetings";
import { managerRoutes } from "../manager/routes";
import { settingsRoutes } from "./settings";
import { syncRoutes } from "./sync";

export function buildApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", csrf);
  // pass-2 routes first: mountSkillsUploadRoutes supersedes the skills handlers in `behavior` (scoped, versioned)
  mountMarketplaceRoutes(api);
  mountSkillsUploadRoutes(api);
  mountExportRoutes(api);
  mountMemoryExtRoutes(api);
  api.route("/", core);
  api.route("/", channelRoutes);
  api.route("/", memory);
  api.route("/", memoryRun);
  api.route("/", meetingRoutes);
  api.route("/", settingsRoutes);
  api.route("/", behavior);
  api.route("/", syncRoutes);
  api.route("/", limitsRoutes);
  api.route("/", managerRoutes);
  api.notFound((c) => c.json({ error: "not_found" }, 404));
  api.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    log.error("api error", { path: c.req.path, err: String(err) });
    return c.json({ error: "internal_error" }, 500);
  });
  return api;
}

const WEB_DIST = () => resolve(tuningEnv().WEB_DIST ?? `${import.meta.dir}/../../../web/dist`);

/** Static web app with SPA fallback. Never answers /api, /auth, /slack, /mcp or /sync paths. */
function mountStatic(app: Hono<any>): void {
  app.get("*", async (c) => {
    const path = c.req.path;
    if (/^\/(api|auth|slack|mcp|mcp-oauth|sync|ext)(\/|$)/.test(path)) return c.json({ error: "not_found" }, 404);
    const root = WEB_DIST();
    let file: string;
    try { file = resolve(root, `.${decodeURIComponent(path)}`); } catch { return c.json({ error: "not_found" }, 404); }
    if (file !== root && !file.startsWith(root + sep)) return c.json({ error: "not_found" }, 404);
    const f = Bun.file(file);
    // hashed chunks never change, so they cache forever; anything else (index.html) must revalidate after a deploy
    if (file !== root && (await f.exists())) return new Response(f, { headers: { "cache-control": /\/chunk-[^/]+$/.test(path) ? "public, max-age=31536000, immutable" : "no-cache" } });
    // a missing file with an extension is a stale asset reference: 404 it, don't hand the SPA shell to a script/css loader
    if (/\.[a-z0-9]{1,8}$/i.test(path)) return c.json({ error: "not_found" }, 404);
    const index = Bun.file(`${root}/index.html`);
    if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    return c.json({ error: "web_not_built" }, 404);
  });
}

/** Mounts /api, the outward MCP server, auth, sync OAuth callbacks and the static web app (last). Call after the other mounts. */
export function mountRoutes(app: Hono<any>): void {
  mountAuth(app);
  mountMcpServer(app);
  mountSyncOAuth(app);
  app.route("/ext", extensionRoutes);
  app.route("/api", buildApi());
  mountStatic(app);
}
