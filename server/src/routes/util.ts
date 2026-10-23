import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

const bad = (status: 400 | 403 | 404 | 409 | 413 | 502, error: string, extra?: object) =>
  new HTTPException(status, { res: Response.json({ error, ...extra }, { status }) });

/** Parses and validates a JSON body; throws a 400 HTTPException (rendered by the api error handler) on failure. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => undefined);
  const r = schema.safeParse(raw);
  if (!r.success) throw bad(400, "invalid_body", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw bad(400, "invalid_query", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

export const httpError = bad;

/** Maps module errors carrying a `code` ("invalid" | "forbidden" | "not_found" | "conflict" | "limit") to HTTP statuses. */
export function codedError(e: unknown): HTTPException {
  const code = (e as { code?: string } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  const status = ({ invalid: 400, forbidden: 403, not_found: 404, conflict: 409, limit: 409 } as Record<string, 400 | 403 | 404 | 409>)[code ?? ""];
  if (!status) throw e;
  return new HTTPException(status, { res: Response.json({ error: code, message }, { status }) });
}
