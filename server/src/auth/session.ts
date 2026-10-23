import { and, eq, gt, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { sha256 } from "../crypto";
import { db } from "../db";
import { sessions, users } from "../db/schema";

export type Role = "owner" | "admin" | "member";
export type AuthUser = { id: string; name: string | null; role: Role; avatarUrl: string | null };
export type AppEnv = { Variables: { user: AuthUser } };

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export const hasRole = (role: Role, min: Role) => RANK[role] >= RANK[min];

export const SESSION_COOKIE = "brain_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const isSecure = () => config.PUBLIC_URL.startsWith("https://");

/** Cookie options shared by every cookie we set. */
export const cookieOpts = (maxAgeSec: number) => ({
  path: "/", httpOnly: true, sameSite: "Lax" as const, secure: isSecure(), maxAge: maxAgeSec,
});

/** Creates a session row (only the sha256 of the token is stored) and sets the cookie. Returns the raw token. */
export async function createSession(c: Context | null, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
  if (c) setCookie(c, SESSION_COOKIE, token, cookieOpts(SESSION_TTL_MS / 1000));
  return token;
}

export async function destroySession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Resolves the cookie to a live user, or null (unknown/expired session, deactivated user). */
export async function userFromRequest(c: Context): Promise<AuthUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name, role: users.role, avatarUrl: users.avatarUrl })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, sql`now()`), eq(users.deactivated, false)))
    .limit(1);
  return row ?? null;
}

/** 401 without a session, 403 below `min`. Sets `c.var.user`. */
export const requireAuth = (min: Role = "member"): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = await userFromRequest(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (!hasRole(user.role, min)) return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  await next();
};

/** Non-GET requests must carry `x-requested-with: fetch` (a custom header forces a CORS preflight). */
export const csrf: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("x-requested-with") !== "fetch") {
    return c.json({ error: "csrf: missing x-requested-with header" }, 403);
  }
  await next();
};
