import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { mountRoutes } from "./routes";
import { mountSlack } from "./slack";
import { mountMcp, mountMcpConnect } from "./mcp";
import { log } from "./log";
import { sql } from "drizzle-orm";
import { config, modelConfigured } from "./config";
import { db } from "./db";
import { jobsStarted } from "./jobs";
import { probeModel } from "./llm";
import { installGate } from "./slack/install";

export const app = new Hono();

// CSP stays off: the SPA ships inline styles; the other defaults (nosniff, frame, referrer, HSTS) apply.
app.use("*", secureHeaders({ contentSecurityPolicy: undefined, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use("*", async (c, next) => {
  const t = Date.now();
  const rid = c.req.header("x-request-id")?.slice(0, 64) || crypto.randomUUID();
  c.header("x-request-id", rid);
  await next();
  if (!c.req.path.startsWith("/healthz")) log.info("http", { rid, m: c.req.method, p: c.req.path, s: c.res.status, ms: Date.now() - t });
});
app.onError((err, c) => {
  log.error("unhandled", { path: c.req.path, err: err.message });
  return c.json({ error: "internal" }, 500);
});

app.use("/slack/*", installGate); // first-install lock (setup token / SLACK_TEAM_ID)
app.get("/healthz", (c) => c.json({ ok: true }));
let modelProbe: { at: number; value: Awaited<ReturnType<typeof probeModel>> } | null = null;
/** Model liveness, cached 30s so orchestrator probes don't spend tokens. */
async function cachedProbe() {
  if (!modelConfigured()) return { ok: false, model: "unconfigured", ms: 0, error: "no model configured" };
  if (!modelProbe || Date.now() - modelProbe.at > 30_000) modelProbe = { at: Date.now(), value: await probeModel("main", 8_000) };
  return modelProbe.value;
}
app.get("/readyz", async (c) => {
  const [dbOk, model] = await Promise.all([db.execute(sql`select 1`).then(() => true, () => false), cachedProbe()]);
  const checks = { db: dbOk, boss: jobsStarted(), model: model.ok };
  const ok = checks.db && checks.boss && checks.model;
  return c.json({ ok, checks, model }, ok ? 200 : 503);
});
mountSlack(app);
mountMcp(app);
mountMcpConnect(app);
mountRoutes(app); // must be last: mounts /auth, /mcp, /api and the SPA fallback
