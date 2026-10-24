import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq, inArray, or } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { mcpConnections, users } from "../db/schema";
import { log } from "../log";
import { assertPublicUrl, guardedFetch } from "../tools/web/ssrf";
import { getPreset } from "./catalog";
import { clearToolCache, type ConnectionRow } from "./client";
import { groupKey } from "./group";
import { connWritable, getOrgWrites } from "./writes";
import { type AuthState, AuthDecryptError, DbOAuthProvider, readAuth, writeAuth } from "./oauth";
import { startGithubConnect } from "./github";

/** Reconnecting is how an unreadable blob gets repaired, so startConnect treats it as empty. */
const readAuthOrEmpty = (id: string): Promise<AuthState> => readAuth(id).catch((e) => (e instanceof AuthDecryptError ? ({} as AuthState) : Promise.reject(e)));

export type Role = "owner" | "admin" | "member";
export type PublicConnection = Omit<ConnectionRow, "authEnc" | "toolMeta"> & {
  ownerName: string | null;
  /** From the last health check; null until one ran. */
  toolCount: number | null; readCount: number | null; writeCount: number | null;
  /** Can write tools run through this connection right now (personal: always; workspace: override or the workspace setting). */
  writesEnabled: boolean;
  /** The real reason it is not healthy, if any. */
  error: string | null;
};

const strip = ({ authEnc: _a, toolMeta, ...rest }: ConnectionRow, ownerName: string | null = null, orgWrites = true): PublicConnection => {
  const writes = toolMeta?.filter((t) => t.kind === "write").length ?? null;
  return {
    ...rest, ownerName, toolCount: toolMeta?.length ?? null, writeCount: writes, readCount: toolMeta ? toolMeta.length - (writes ?? 0) : null,
    writesEnabled: connWritable(rest, orgWrites), error: rest.status === "connected" ? null : rest.lastError,
  };
};

async function withOwners(rows: ConnectionRow[]): Promise<PublicConnection[]> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const orgWrites = await getOrgWrites();
  return rows.map((r) => strip(r, r.ownerUserId ? (names.get(r.ownerUserId) ?? null) : null, orgWrites));
}

export async function getConnection(connectionId: string): Promise<ConnectionRow | undefined> {
  const [row] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  return row;
}

/** Members see org connections + their own; admins/owners see everything. Secrets never leave this module. */
export async function listConnections(userId: string, role: Role): Promise<PublicConnection[]> {
  const rows = role === "member"
    ? await db.select().from(mcpConnections).where(or(eq(mcpConnections.scope, "org"), eq(mcpConnections.ownerUserId, userId)))
    : await db.select().from(mcpConnections);
  return withOwners(rows);
}

/** Admin action: turn someone's personal connection into a workspace one (everyone can use it; writes follow the workspace setting). */
export async function makeWorkspaceWide(connectionId: string): Promise<PublicConnection> {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error("connection not found");
  if (conn.scope === "org") throw new Error("already workspace-wide");
  // Legacy GitHub PAT/MCP connections may already be workspace-wide. New GitHub
  // App OAuth connections never carry `bearer` and can never be shared.
  const legacyGithubToken = conn.provider === "github" && (await readAuthOrEmpty(conn.id)).bearer === true;
  if (getPreset(conn.provider)?.personalOnly && !legacyGithubToken) throw new Error(`${conn.label} can only be connected personally`);
  const dup = (await db.select().from(mcpConnections).where(eq(mcpConnections.scope, "org"))).find((c) => groupKey(c) === groupKey(conn));
  if (dup) throw new Error(`${dup.label} is already connected workspace-wide; remove one of them first`);
  await db.update(mcpConnections).set({ scope: "org", ownerUserId: null, allowWrites: null }).where(eq(mcpConnections.id, connectionId));
  return (await withOwners([(await getConnection(connectionId))!]))[0]!;
}

/** Admin action: per-connection override of the workspace write setting; null = inherit. */
export async function setAllowWrites(connectionId: string, allow: boolean | null): Promise<PublicConnection> {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error("connection not found");
  await db.update(mcpConnections).set({ allowWrites: allow }).where(eq(mcpConnections.id, connectionId));
  return (await withOwners([(await getConnection(connectionId))!]))[0]!;
}

export async function createConnection(a: {
  provider?: string;
  url?: string;
  label?: string;
  scope: "org" | "user";
  ownerUserId?: string | null;
  /** Static API token for non-OAuth servers; stored encrypted, connection is immediately connected. */
  token?: string;
}): Promise<PublicConnection> {
  const preset = a.provider ? getPreset(a.provider) : undefined;
  if (a.provider && a.provider !== "custom" && !preset) throw new Error(`unknown provider: ${a.provider}`);
  if (!preset && !a.url) throw new Error("url is required for custom connections");
  // Keep historic GitHub PAT/MCP rows operable. The Marketplace cannot create
  // these anymore; all new GitHub connections use personal App OAuth instead.
  const legacyGithubToken = a.provider === "github" && !!a.token;
  if (preset?.personalOnly && a.scope === "org" && !legacyGithubToken) throw new Error(`${preset.label} can only be connected personally`);
  if (a.scope === "user" && !a.ownerUserId) throw new Error("ownerUserId is required for user-scoped connections");
  const url = preset?.url ?? a.url!;
  if (!preset) await assertPublicUrl(url);
  const label = a.label?.trim() || preset?.label || new URL(url).hostname;
  const row = {
    id: newId("mcp_"),
    provider: preset?.key ?? "custom",
    label,
    url,
    scope: a.scope,
    ownerUserId: a.scope === "user" ? a.ownerUserId! : null,
    status: a.token ? ("connected" as const) : ("pending" as const),
    connectedAt: a.token ? new Date() : null,
  };
  await db.insert(mcpConnections).values(row);
  if (a.token) await writeAuth(row.id, { accessToken: a.token, bearer: true }, true);
  return (await withOwners([(await getConnection(row.id))!]))[0]!;
}

/** Begins OAuth 2.1 (DCR + PKCE). Resolves with the URL the user must visit. */
export async function startConnect(connectionId: string): Promise<{ authUrl: string }> {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error("connection not found");
  if ((await readAuthOrEmpty(connectionId)).bearer) throw new Error("this connection uses a static token; nothing to authorize");
  if (conn.provider === "github") return startGithubConnect(connectionId);
  if (!getPreset(conn.provider)) await assertPublicUrl(conn.url);
  // fresh handshake: drop old tokens but keep the registered client
  const prev = await readAuthOrEmpty(connectionId);
  await writeAuth(connectionId, { clientInfo: prev.clientInfo }, true);
  const provider = new DbOAuthProvider(connectionId, true);
  const result = await auth(provider, { serverUrl: conn.url, fetchFn: guardedFetch });
  if (result !== "REDIRECT" || !provider.authUrl) throw new Error("server did not request authorization");
  await db.update(mcpConnections).set({ status: "pending" }).where(eq(mcpConnections.id, connectionId));
  return { authUrl: provider.authUrl.toString() };
}

export async function handleOAuthCallback(code: string, state: string): Promise<{ connectionId: string; label: string }> {
  const connectionId = state.split(".")[0] ?? "";
  const conn = await getConnection(connectionId);
  const a = conn ? await readAuth(connectionId) : undefined;
  if (!conn || !a?.state || a.state !== state || !a.stateExpiresAt || a.stateExpiresAt < Date.now()) throw new Error("invalid or expired OAuth state");
  try {
    const result = await auth(new DbOAuthProvider(connectionId, true), { serverUrl: conn.url, authorizationCode: code, fetchFn: guardedFetch });
    if (result !== "AUTHORIZED") throw new Error("authorization was not completed");
  } catch (e) {
    await db.update(mcpConnections).set({ status: "error" }).where(eq(mcpConnections.id, connectionId));
    log.warn("mcp oauth callback failed", { connectionId, error: String(e) });
    throw e;
  }
  clearToolCache(connectionId);
  return { connectionId, label: conn.label };
}

/** Owner of a user connection, or an admin/owner (org connections need admin). */
export async function deleteConnection(connectionId: string, userId: string): Promise<boolean> {
  const conn = await getConnection(connectionId);
  if (!conn) return false;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  const admin = u?.role === "admin" || u?.role === "owner";
  const allowed = conn.scope === "user" ? conn.ownerUserId === userId || admin : admin;
  if (!allowed) throw new Error("not allowed to delete this connection");
  await db.delete(mcpConnections).where(and(eq(mcpConnections.id, connectionId)));
  clearToolCache(connectionId);
  return true;
}
