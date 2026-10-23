import "../turn/env";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSession, csrf, type AppEnv } from "../../src/auth/session";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";

export const api = new Hono<AppEnv>();
api.use("*", csrf);
api.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: "internal_error", detail: String(err) }, 500)));
export const app = new Hono();
app.mount("/api", api.fetch); // lazy: test files add routes to `api` after import

export async function login(id: string, role: "owner" | "admin" | "member" = "member") {
  await db.insert(users).values({ id, name: `User ${id}`, role }).onConflictDoNothing();
  return `brain_session=${await createSession(null, id)}`;
}

export function call(method: string, path: string, o: { cookie?: string; body?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET") headers["x-requested-with"] = "fetch";
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return app.request(path, { method, headers, body });
}
