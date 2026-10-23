import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
let resolver: Resolver = systemResolver;
/** Test seam (DNS rebinding simulations). Pass undefined to restore. */
export const setResolver = (r?: Resolver) => { resolver = r ?? systemResolver; };

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (v4 + v6). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const l = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
    const mapped = l.match(/^[0:]*ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    const hexMapped = l.match(/^[0:]*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      l === "::" || l === "::1" ||
      /^f[cd]/.test(l) || // fc00::/7 unique local
      /^fe[89ab]/.test(l) || // fe80::/10 link local
      l.startsWith("ff") || // multicast
      l.startsWith("64:ff9b:") || l.startsWith("2001:db8")
    );
  }
  return true; // not an IP -> treat as unsafe
}

/** Validates scheme + resolves DNS and rejects if ANY address is non-public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (u.username || u.password) throw new Error("credentials in URL are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("blocked host");
  }
  const addrs = isIP(host) ? [host] : await resolver(host);
  if (!addrs.length) throw new Error("host did not resolve");
  if (addrs.some(isPrivateIp)) throw new Error("blocked: resolves to a private or reserved address");
  return u;
}

export type SafeFetchOpts = { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; headers?: Record<string, string> };

// ponytail: DNS is resolved by us then again by fetch (TOCTOU rebinding window); pin the IP via a custom agent if this ever faces hostile DNS.
/** fetch with per-hop SSRF validation, manual redirects, timeout and a hard body size cap. */
export async function safeFetch(
  raw: string,
  opts: SafeFetchOpts = {},
): Promise<{ url: string; status: number; contentType: string; body: Uint8Array; truncated: boolean }> {
  const { maxBytes = 2_000_000, timeoutMs = 15_000, maxRedirects = 5 } = opts;
  const signal = AbortSignal.timeout(timeoutMs);
  let url = raw;
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, { redirect: "manual", signal, headers: { "user-agent": "CompanyBrain/1.0", ...opts.headers } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= maxRedirects) throw new Error("too many redirects");
      url = new URL(res.headers.get("location")!, u).toString();
      await res.body?.cancel();
      continue;
    }
    const chunks: Uint8Array[] = [];
    let size = 0, truncated = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        chunks.push(value.subarray(0, value.length - (size - maxBytes)));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { url: u.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks), truncated };
  }
}

const HOP_LIMIT = 5;
const DEFAULT_GUARDED_TIMEOUT_MS = 5 * 60_000;

/**
 * Drop-in `fetch` for third-party URLs we do not control (MCP servers, OAuth discovery/token/registration endpoints).
 * Every hop is validated by assertPublicUrl (scheme, credentials, DNS -> no private/reserved address), redirects are
 * followed manually with the same check, credentials never follow a cross-origin redirect, and a hard timeout applies.
 * The body is NOT buffered, so streaming (SSE) works.
 */
export const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : undefined;
  let url = req ? req.url : String(input);
  let method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  let body = init?.body ?? undefined;
  const headers = new Headers(init?.headers ?? req?.headers);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(DEFAULT_GUARDED_TIMEOUT_MS)])
    : AbortSignal.timeout(DEFAULT_GUARDED_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, { ...init, method, body, headers, signal, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    if (hop >= HOP_LIMIT) { await res.body?.cancel(); throw new Error("too many redirects"); }
    await res.body?.cancel();
    const next = new URL(loc, u);
    if (next.origin !== u.origin) { headers.delete("authorization"); headers.delete("cookie"); }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; headers.delete("content-type"); }
    url = next.toString();
  }
}) as typeof fetch;
