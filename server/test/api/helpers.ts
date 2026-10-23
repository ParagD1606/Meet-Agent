import { Hono } from "hono";
import { createSession } from "../../src/auth/session";
import { config } from "../../src/config";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { mountRoutes } from "../../src/routes";

export { db, resetDb } from "../db";

config.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export const app = new Hono();
mountRoutes(app);

export type Role = "owner" | "admin" | "member";

export async function mkUser(id: string, role: Role = "member", extra: Partial<typeof users.$inferInsert> = {}) {
  await db.insert(users).values({ id, name: `User ${id}`, role, ...extra });
  return id;
}

/** Inserts a user and returns a ready-to-send Cookie header for a fresh session. */
export async function login(id: string, role: Role = "member") {
  await mkUser(id, role);
  return `brain_session=${await createSession(null, id)}`;
}

export function call(method: string, path: string, o: { cookie?: string; body?: unknown; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.csrf !== false && method !== "GET") headers["x-requested-with"] = "fetch";
  let body: string | undefined;
  if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return app.request(path, { method, headers, body });
}
