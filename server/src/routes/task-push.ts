import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import { pushCommitments, pushMeetingItems, type PushResult, type Target } from "../export/push";
import { githubReady } from "../integrations/github-issues";
import { getTrello } from "../integrations/trello";
import { httpError, readBody } from "./util";

export const taskPushRoutes = new Hono<AppEnv>();

const target = z.enum(["trello", "github"]);
const ids = z.array(z.string().trim().min(1).max(100)).min(1).max(100);

const user = (c: import("hono").Context<AppEnv>) => { const u = c.get("user"); return { id: u.id, role: u.role }; };

/** A clear 409 before anything is attempted when the target has no credentials yet. */
async function configured(t: Target) {
  const ok = t === "trello" ? !!(await getTrello())?.listId : await githubReady();
  if (!ok) throw httpError(409, "not_configured", { message: `${t === "trello" ? "Trello" : "GitHub"} is not configured yet: an admin must set it up under Integrations > Task boards` });
}

const summary = (results: PushResult[]) => ({
  results,
  created: results.filter((r) => r.status === "created").length, existing: results.filter((r) => r.status === "existing").length,
  skipped: results.filter((r) => r.status === "skipped").length, failed: results.filter((r) => r.status === "failed").length,
});

/** One item: the outcome picks the HTTP status so a client can react; bulk calls always answer 200 with per-item results. */
function single(c: import("hono").Context<AppEnv>, r: PushResult) {
  const body = { ...summary([r]), result: r };
  if (r.status === "skipped") return c.json(body, r.reason === "not_found" ? 404 : /^Only an admin/.test(r.reason ?? "") ? 403 : 422);
  if (r.status === "failed") return c.json(body, /rate limit/i.test(r.reason ?? "") ? 429 : 502);
  return c.json(body);
}

taskPushRoutes.post("/tasks/push", requireAuth(), async (c) => {
  const b = await readBody(c, z.object({ target, ids }));
  await configured(b.target);
  return c.json(summary(await pushCommitments(b.ids, b.target, user(c))));
});

taskPushRoutes.post("/tasks/:id/push", requireAuth(), async (c) => {
  const b = await readBody(c, z.object({ target }));
  await configured(b.target);
  return single(c, (await pushCommitments([c.req.param("id")], b.target, user(c)))[0]!);
});

taskPushRoutes.post("/meetings/:id/items/:itemId/push", requireAuth(), async (c) => {
  const b = await readBody(c, z.object({ target }));
  await configured(b.target);
  const r = await pushMeetingItems(c.req.param("id"), b.target, user(c), [c.req.param("itemId")]);
  if (!r) throw httpError(404, "not_found");
  return single(c, r[0]!);
});

taskPushRoutes.post("/meetings/:id/push", requireAuth(), async (c) => {
  const b = await readBody(c, z.object({ target, itemIds: ids.optional(), all: z.literal("approved").optional() }).refine((v) => !!v.itemIds || v.all === "approved", "itemIds or all:'approved' is required"));
  await configured(b.target);
  const r = await pushMeetingItems(c.req.param("id"), b.target, user(c), b.itemIds ?? "approved");
  if (!r) throw httpError(404, "not_found");
  return c.json(summary(r));
});
