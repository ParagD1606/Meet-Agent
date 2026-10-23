import { count, desc, eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, userFromRequest, hasRole, type AppEnv } from "../auth/session";
import { config } from "../config";
import { id, sha256 } from "../crypto";
import { db } from "../db";
import { apiTokens, automations, mcpConnections, memories, turns, users, workspace } from "../db/schema";
import { slackManifestYaml } from "./manifest";
import { SYNC_PROVIDER_IDS } from "../sync/types";
import { PROVIDERS } from "../sync";
import { httpError, readBody, readQuery } from "./util";
import { randomBytes } from "node:crypto";

export const core = new Hono<AppEnv>();

core.get("/me", requireAuth(), (c) => c.json(c.get("user")));

// ---------- users ----------
core.get("/users", requireAuth("admin"), async (c) => {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: users.role })
    .from(users)
    .where(and(eq(users.deactivated, false), eq(users.isBot, false)))
    .orderBy(users.name);
  return c.json(rows);
});

core.put("/users/:id/role", requireAuth("owner"), async (c) => {
  const { role } = await readBody(c, z.object({ role: z.enum(["admin", "member"]) }));
  const target = c.req.param("id");
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, target));
  if (!u) throw httpError(404, "not_found");
  if (u.role === "owner") throw httpError(400, "cannot_change_owner");
  await db.update(users).set({ role }).where(eq(users.id, target));
  return c.json({ id: target, role });
});

// ---------- setup (public until a workspace exists, then admin) ----------
const setupGate = async (c: Parameters<ReturnType<typeof requireAuth>>[0], next: () => Promise<void>) => {
  const [ws] = await db.select({ id: workspace.id }).from(workspace).limit(1);
  if (ws) {
    const user = await userFromRequest(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!hasRole(user.role, "admin")) return c.json({ error: "forbidden" }, 403);
    c.set("user", user);
  }
  await next();
};

core.get("/setup/status", setupGate, async (c) => {
  const [ws] = await db.select({ id: workspace.id, name: workspace.name }).from(workspace).limit(1);
  return c.json({
    model: Boolean(config.MODEL_API_KEY || config.MODEL_BASE_URL),
    embedding: Boolean(config.EMBEDDING_API_KEY || config.MODEL_API_KEY || config.MODEL_BASE_URL),
    slack: Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET && (config.SLACK_MODE === "socket" ? config.SLACK_APP_TOKEN : config.SLACK_SIGNING_SECRET)),
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    publicUrl: config.PUBLIC_URL,
    slackMode: config.SLACK_MODE,
    sync: Object.fromEntries(SYNC_PROVIDER_IDS.map((p) => [p, PROVIDERS[p].configured()])),
  });
});

core.get("/setup/manifest", setupGate, (c) =>
  c.body(slackManifestYaml(config.PUBLIC_URL), 200, { "content-type": "text/yaml; charset=utf-8" }));

// ---------- overview / turns ----------
const turnCols = {
  id: turns.id, channelId: turns.channelId, userId: turns.userId, trigger: turns.trigger, status: turns.status,
  inputTokens: turns.inputTokens, outputTokens: turns.outputTokens, startedAt: turns.startedAt, finishedAt: turns.finishedAt,
};

core.get("/overview", requireAuth(), async (c) => {
  const user = c.get("user");
  const admin = hasRole(user.role, "admin");
  const [[mem], [conn], [auto], recentTurns] = await Promise.all([
    db.select({ n: count() }).from(memories).where(and(eq(memories.scopeTag, "shared"), eq(memories.status, "active"))),
    db.select({ n: count() }).from(mcpConnections).where(eq(mcpConnections.status, "connected")),
    db.select({ n: count() }).from(automations).where(eq(automations.enabled, true)),
    // Members only ever see their own turns.
    db.select(turnCols).from(turns).where(admin ? undefined : eq(turns.userId, user.id)).orderBy(desc(turns.startedAt)).limit(10),
  ]);
  return c.json({ memoryCount: mem!.n, connections: conn!.n, automations: auto!.n, recentTurns });
});

core.get("/turns", requireAuth("admin"), async (c) => {
  const { limit } = readQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const rows = await db
    .select({ ...turnCols, threadTs: turns.threadTs, toolCalls: turns.toolCalls, error: turns.error })
    .from(turns).orderBy(desc(turns.startedAt)).limit(limit);
  return c.json(rows);
});

// ---------- API tokens (outward MCP server) ----------
core.get("/tokens", requireAuth("admin"), async (c) =>
  c.json(await db.select({ id: apiTokens.id, name: apiTokens.name, userId: apiTokens.userId, createdAt: apiTokens.createdAt }).from(apiTokens).orderBy(desc(apiTokens.createdAt))));

core.post("/tokens", requireAuth("admin"), async (c) => {
  const { name } = await readBody(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const token = `cbt_${randomBytes(32).toString("base64url")}`;
  const row = { id: id("tok_"), userId: c.get("user").id, name, hash: sha256(token) };
  await db.insert(apiTokens).values(row);
  // The raw token is returned exactly once; only its hash is stored.
  return c.json({ id: row.id, name, token }, 201);
});

core.delete("/tokens/:id", requireAuth("admin"), async (c) => {
  const rows = await db.delete(apiTokens).where(eq(apiTokens.id, c.req.param("id"))).returning({ id: apiTokens.id });
  if (!rows.length) throw httpError(404, "not_found");
  return c.json({ ok: true });
});
