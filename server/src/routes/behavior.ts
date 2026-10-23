import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../auth/session";
import {
  AutomationError, createAutomation, deleteAutomation, listAutomations, updateAutomation, type Actor,
} from "../automations/automations";
import { runNow } from "../automations/run";
import { PRESETS, createConnection, deleteConnection, getConnection, listConnections, startConnect } from "../mcp";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../skills/skills";
import { codedError, httpError, readBody } from "./util";

export const behavior = new Hono<AppEnv>();

const actorOf = (u: AppEnv["Variables"]["user"]): Actor => ({ userId: u.id, role: u.role, source: "api" });
const isAdmin = (r: string) => r === "admin" || r === "owner";

// ---------- automations (members manage their own, admins manage all) ----------
const autoBase = z.object({
  prompt: z.string().trim().min(1).max(4000),
  cron: z.string().trim().max(100).nullish(),
  runAt: z.iso.datetime({ offset: true }).nullish(),
  destChannelId: z.string().trim().max(40).nullish(),
  enabled: z.boolean().optional(),
});
const autoCreate = autoBase.extend({ kind: z.enum(["digest", "reminder"]), ownerUserId: z.string().max(40).optional() });

const auto = <T>(f: () => Promise<T>) => f().catch((e) => { throw e instanceof AutomationError ? codedError(e) : e; });

behavior.get("/automations", requireAuth(), async (c) => c.json(await listAutomations(actorOf(c.get("user")))));
behavior.post("/automations", requireAuth(), async (c) => {
  const input = await readBody(c, autoCreate);
  return c.json(await auto(() => createAutomation(input, actorOf(c.get("user")))), 201);
});
behavior.patch("/automations/:id", requireAuth(), async (c) => {
  const patch = await readBody(c, autoBase.partial());
  return c.json(await auto(() => updateAutomation(c.req.param("id"), patch, actorOf(c.get("user")))));
});
behavior.delete("/automations/:id", requireAuth(), async (c) => {
  await auto(() => deleteAutomation(c.req.param("id"), actorOf(c.get("user"))));
  return c.json({ ok: true });
});
behavior.post("/automations/:id/run", requireAuth(), async (c) => {
  const id = c.req.param("id");
  const actor = actorOf(c.get("user"));
  // listAutomations is already scoped to what this actor may see/manage.
  if (!(await listAutomations(actor)).some((a) => a.id === id)) throw httpError(404, "not_found");
  return c.json(await auto(() => runNow(id, actor)));
});

// ---------- MCP connections ----------
behavior.get("/mcp/presets", requireAuth(), (c) => c.json(PRESETS.map(({ trusted: _t, ...p }) => p)));
behavior.get("/mcp/connections", requireAuth(), async (c) => {
  const u = c.get("user");
  return c.json(await listConnections(u.id, u.role));
});
behavior.post("/mcp/connections", requireAuth(), async (c) => {
  const u = c.get("user");
  const b = await readBody(c, z.object({
    provider: z.string().max(60).optional(),
    url: z.url().max(2000).optional(),
    label: z.string().trim().max(80).optional(),
    scope: z.enum(["org", "user"]),
    token: z.string().max(4000).optional(),
  }).refine((v) => v.provider || v.url, { message: "provider or url required" }));
  if (b.scope === "org" && !isAdmin(u.role)) throw httpError(403, "forbidden");
  try {
    return c.json(await createConnection({ ...b, ownerUserId: b.scope === "user" ? u.id : null }), 201);
  } catch (e) {
    throw httpError(400, "invalid_connection", { message: e instanceof Error ? e.message : String(e) });
  }
});
behavior.delete("/mcp/connections/:id", requireAuth(), async (c) => {
  const u = c.get("user");
  try {
    if (!(await deleteConnection(c.req.param("id"), u.id))) throw httpError(404, "not_found");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("not allowed")) throw httpError(403, "forbidden");
    throw e;
  }
  return c.json({ ok: true });
});
behavior.post("/mcp/connections/:id/connect", requireAuth(), async (c) => {
  const u = c.get("user");
  const conn = await getConnection(c.req.param("id"));
  if (!conn) throw httpError(404, "not_found");
  const allowed = conn.scope === "user" ? conn.ownerUserId === u.id : isAdmin(u.role);
  if (!allowed) throw httpError(403, "forbidden");
  try {
    return c.json(await startConnect(conn.id));
  } catch (e) {
    throw httpError(400, "connect_failed", { message: e instanceof Error ? e.message : String(e) });
  }
});
