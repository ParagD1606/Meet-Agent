import { Hono } from "hono";
import { mountRoutes } from "./routes";
import { mountSlack } from "./slack";
import { mountMcp } from "./mcp";
import { log } from "./log";

export const app = new Hono();

app.use("*", async (c, next) => {
  const t = Date.now();
  await next();
  if (!c.req.path.startsWith("/healthz")) log.info("http", { m: c.req.method, p: c.req.path, s: c.res.status, ms: Date.now() - t });
});
app.onError((err, c) => {
  log.error("unhandled", { path: c.req.path, err: err.message });
  return c.json({ error: "internal" }, 500);
});

app.get("/healthz", (c) => c.json({ ok: true }));
mountSlack(app);
mountMcp(app);
mountRoutes(app); // must be last: mounts /auth, /mcp, /api and the SPA fallback
