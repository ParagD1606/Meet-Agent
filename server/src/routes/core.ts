import { count, desc, eq, and, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { requireAuth, userFromRequest, hasRole, type AppEnv } from "../auth/session";
import { config, modelConfigured } from "../config";
import { id, sha256 } from "../crypto";
import { db } from "../db";
import { apiTokens, automations, channelMembers, channels, mcpConnections, memories, turns, users, workspace } from "../db/schema";
import { ownerExists } from "../auth/setup-token";
import { bootstrapScope, resetBootstrapSchedule } from "../memory/bootstrap";
import { jobsStarted } from "../jobs";
import { probeModel } from "../llm";
import { postDm } from "../slack/client";
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
  const model = modelConfigured();
  const embedding = Boolean(config.EMBEDDING_API_KEY || config.MODEL_API_KEY || config.MODEL_BASE_URL || config.MODEL_PROVIDER === "vertex");
  const slack = Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET && (config.SLACK_MODE === "socket" ? config.SLACK_APP_TOKEN : config.SLACK_SIGNING_SECRET));
  const dbOk = await db.execute(sql`select 1`).then(() => true, () => false);
  return c.json({
    model, embedding, slack,
    ownerLocked: await ownerExists(),
    teamPinned: Boolean(config.SLACK_TEAM_ID),
    // configured-ness only; use POST /setup/test-message or /readyz for live probes
    checks: { db: dbOk, boss: jobsStarted(), model, embedding, slack: slack && Boolean(ws) },
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    publicUrl: config.PUBLIC_URL,
    slackMode: config.SLACK_MODE,
    sync: Object.fromEntries(SYNC_PROVIDER_IDS.map((p) => [p, PROVIDERS[p].configured()])),
  });
});

/** Sends a real DM to the signed-in admin through the installed bot, proving token + scopes work end to end. */
core.post("/setup/test-message", requireAuth("admin"), async (c) => {
  const [ws] = await db.select({ id: workspace.id }).from(workspace).limit(1);
  if (!ws) throw httpError(409, "no_workspace", { message: "Install the Slack app first." });
  try {
    const ts = await postDm(c.get("user").id, "Test message from Brain: Slack is connected and I can DM you.");
    if (!ts) throw httpError(502, "dm_failed", { message: "Slack did not accept the message." });
    return c.json({ ok: true, ts });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw httpError(502, "dm_failed", { message: e instanceof Error ? e.message : String(e) });
  }
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

const TURN_STATUS = ["running", "done", "error", "waiting_approval"] as const;
const permalink = (wsId: string | undefined, channelId: string, threadTs: string | null) =>
  wsId && threadTs ? `https://app.slack.com/client/${wsId}/${channelId}/thread/${channelId}-${threadTs}` : null;

/** Filters + keyset cursor (`startedAt|id` of the last row; pass back as `cursor`). Returns a bare array, newest first. */
core.get("/turns", requireAuth("admin"), async (c) => {
  const q = readQuery(c, z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    status: z.enum(TURN_STATUS).optional(),
    trigger: z.string().max(30).optional(),
    channel: z.string().max(40).optional(),
    user: z.string().max(40).optional(),
    cursor: z.string().max(80).optional(),
  }));
  let cur: { at: Date; id: string } | null = null;
  if (q.cursor) {
    const [at, ...rest] = q.cursor.split("|");
    const d = new Date(at ?? "");
    if (Number.isNaN(d.getTime()) || !rest.length) throw httpError(400, "invalid_cursor");
    cur = { at: d, id: rest.join("|") };
  }
  const rows = await db
    .select({ ...turnCols, threadTs: turns.threadTs, toolCalls: turns.toolCalls, error: turns.error, depth: turns.depth, model: turns.model, costMicros: turns.costMicros, steps: turns.steps })
    .from(turns)
    .where(and(
      q.status ? eq(turns.status, q.status) : undefined,
      q.trigger ? eq(turns.trigger, q.trigger) : undefined,
      q.channel ? eq(turns.channelId, q.channel) : undefined,
      q.user ? eq(turns.userId, q.user) : undefined,
      cur ? sql`(${turns.startedAt}, ${turns.id}) < (${cur.at.toISOString()}::timestamptz, ${cur.id})` : undefined,
    ))
    .orderBy(desc(turns.startedAt), desc(turns.id)).limit(q.limit);
  const last = rows.at(-1);
  if (last && rows.length === q.limit) c.header("x-next-cursor", `${last.startedAt.toISOString()}|${last.id}`);
  return c.json(rows);
});

core.get("/turns/:id", requireAuth("admin"), async (c) => {
  const [row] = await db.select().from(turns).where(eq(turns.id, c.req.param("id")));
  if (!row) throw httpError(404, "not_found");
  const [ws] = await db.select({ id: workspace.id }).from(workspace).limit(1);
  return c.json({ ...row, permalink: permalink(ws?.id, row.channelId, row.threadTs) });
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

// ---------- core block bootstrap (About:/Profile: lines) ----------
/**
 * Body {scope:"channel:<id>"|"user:<id>"|"user:me"|"all"}. Admins: anything ("all" re-queues every channel and user for the
 * background job, 409 without a model). Members: only their own user block. Text is echoed only where the caller could read it anyway.
 */
core.post("/core-blocks/bootstrap", requireAuth(), async (c) => {
  const me = c.get("user");
  const admin = hasRole(me.role, "admin");
  const { scope } = await readBody(c, z.object({ scope: z.string().max(80) }));
  if (scope === "all") {
    if (!admin) throw httpError(403, "forbidden");
    if (!modelConfigured()) throw httpError(409, "no_model");
    await resetBootstrapSchedule();
    return c.json({ queued: true, results: [] });
  }
  const m = /^(channel|user):([A-Za-z0-9_]+)$/.exec(scope);
  if (!m) throw httpError(400, "invalid_scope");
  const target = m[1] === "user" && m[2] === "me" ? me.id : m[2]!;
  if (m[1] === "user" ? target !== me.id && !admin : !admin) throw httpError(403, "forbidden");
  let canRead = m[1] === "user" && target === me.id;
  if (m[1] === "channel") {
    const [ch] = await db.select({ isPrivate: channels.isPrivate }).from(channels).where(eq(channels.id, target));
    if (!ch) throw httpError(404, "not_found");
    canRead = !ch.isPrivate || Boolean((await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, target), eq(channelMembers.userId, me.id))))[0]);
    if (!canRead) throw httpError(404, "not_found"); // same non-enumerability as GET /core-blocks
  }
  const { line, ...r } = await bootstrapScope(`${m[1]}:${target}`);
  return c.json({ queued: false, results: [canRead ? { ...r, line } : r] });
});
