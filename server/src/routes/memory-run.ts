import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { RUN_JOBS, runNow } from "../memory/run-now";
import { readBody } from "./util";

export const memoryRun = new Hono<AppEnv>();

/** "Learn now": run a memory job immediately. Admin only, one run per job at a time (409), a few starts per minute (429). */
memoryRun.post("/memory/run", requireAuth("admin"), async (c) => {
  const { job } = await readBody(c, z.object({ job: z.enum(RUN_JOBS) }));
  const r = await runNow(job);
  if (r.ok) return c.json(r);
  if (r.error === "already_running") return c.json(r, 409);
  if (r.error === "rate_limited") { c.header("retry-after", String(r.retryAfterSec)); return c.json(r, 429); }
  return c.json(r, 500);
});
