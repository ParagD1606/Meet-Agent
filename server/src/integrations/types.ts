import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "../crypto";
import { db } from "../db";
import { settings } from "../db/schema";

export type ErrorCode = "not_configured" | "unauthorized" | "rate_limited" | "not_found" | "invalid" | "upstream";

/** A failure that is safe to show to the user: messages never contain URLs, keys or tokens. */
export class IntegrationError extends Error {
  constructor(public code: ErrorCode, message: string, public retryAfter?: number) { super(message); }
}

export type PushPayload = {
  title: string; description: string; sourceUrl: string; quote: string; due: Date | null;
  ownerId: string | null; ownerName: string | null; origin: string; // origin: "meeting <title>" | "Slack"
};
export type Created = { id: string; url: string };

/** Card / issue body shared by both targets. Plain text with markdown links; no secrets by construction. */
export function describe(p: PushPayload, extra: string[] = []): string {
  return [
    p.description.trim(),
    p.sourceUrl && `Source: ${p.sourceUrl}`,
    p.quote.trim() && `> ${p.quote.trim().replace(/\s*\n\s*/g, " ")}`,
    ...extra,
    `Created by Pixel from ${p.origin}${p.sourceUrl ? ` (${p.sourceUrl})` : ""}`,
  ].filter(Boolean).join("\n\n");
}

/** Fetch wrapper: maps HTTP failures to IntegrationError and hides network error text (it may embed the URL with credentials). */
export async function call(what: string, base: string, path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<unknown> {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new IntegrationError("upstream", `${what} could not be reached`); }
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  const limited = res.status === 429 || (res.status === 403 && (!!res.headers.get("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"));
  if (res.status === 401 || (res.status === 403 && !limited))
    throw new IntegrationError("unauthorized", `${what} rejected the credentials (${res.status}); check the token and its permissions`);
  if (limited) {
    const retry = Number(res.headers.get("retry-after")) || undefined;
    throw new IntegrationError("rate_limited", `${what} rate limit reached${retry ? `; retry in ${retry}s` : ""}`, retry);
  }
  if (res.status === 404) throw new IntegrationError("not_found", `${what} could not find the board, list or repository (404); check the ids and access`);
  if (res.status === 400 || res.status === 422) throw new IntegrationError("invalid", `${what} refused the request (${res.status})`);
  throw new IntegrationError("upstream", `${what} failed (${res.status})`);
}

// ---------- settings rows (`integration:<name>`), token encrypted with the connections' crypto helper ----------
export async function readIntegration<T extends object>(name: string): Promise<(T & { tokenEnc?: string }) | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, `integration:${name}`));
  return (row?.value as (T & { tokenEnc?: string }) | undefined) ?? null;
}
export const writeIntegration = (name: string, value: object) =>
  db.insert(settings).values({ key: `integration:${name}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
export const sealToken = (t: string) => encrypt(t);
export const openToken = (enc: string) => decrypt(enc);
export const last4 = (s: string) => s.slice(-4);
