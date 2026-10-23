import { log } from "../log";

/** Chars of an MCP result the model sees inline; the rest is spilled (turn/spill) behind a handle. */
export const MCP_PREVIEW_CHARS = 1500;
/** Used only when turn/spill is unavailable: hard cap with an explicit note (never silent truncation). */
const FALLBACK_CHARS = 8000;

// Server bookkeeping the model never needs: API urls, ids of avatars, etags, hypermedia links.
const DROP_KEY = /^(node_id|gravatar_id|etag|_links|links|_?[mM]etadata|avatar_url|avatar_urls|self|\w+_url|\w+Url)$/;
const KEEP_URL = /^(html_url|web_url|permalink|permalink_url|htmlUrl|webUrl)$/i;
const TAG = /<\/?[a-z][^>]*>/i;

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function clean(v: unknown): unknown {
  if (typeof v === "string") { const s = TAG.test(v) ? stripHtml(v) : v.trim(); return s === "" ? undefined : s; }
  if (Array.isArray(v)) { const a = v.map(clean).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEY.test(k) && !KEEP_URL.test(k)) continue;
      const c = clean(x);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === undefined ? undefined : v;
}

function pick(v: unknown, path: string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => pick(x, path));
  if (!v || typeof v !== "object") return undefined;
  const [h, ...rest] = path;
  const x = (v as Record<string, unknown>)[h!];
  return rest.length ? pick(x, rest) : x;
}

function setPath(out: Record<string, unknown>, path: string[], val: unknown) {
  let o = out;
  for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[path[path.length - 1]!] = val;
}

/** Keeps only `fields` (dot paths), mapped over arrays. Unwraps a single-array envelope ({items:[...]}) when needed. */
export function project(v: unknown, fields: string[]): unknown {
  const paths = fields.map((f) => f.split(".").filter(Boolean)).filter((p) => p.length);
  if (!paths.length) return v;
  if (Array.isArray(v)) return v.map((x) => project(x, fields));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const hit = paths.some((p) => p[0]! in o);
    if (!hit) {
      const arrays = Object.entries(o).filter(([, x]) => Array.isArray(x));
      if (arrays.length === 1) return project(arrays[0]![1], fields);
    }
    const out: Record<string, unknown> = {};
    for (const p of paths) { const x = pick(o, p); if (x !== undefined) setPath(out, p, x); }
    return out;
  }
  return v;
}

/** Compact JSON for JSON results (nulls/empties/metadata/HTML dropped, optional field projection); tidy text otherwise. */
export function minifyResult(text: string, opts: { fields?: string[] } = {}): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      let data: unknown = JSON.parse(t);
      if (opts.fields?.length) data = project(data, opts.fields);
      return JSON.stringify(clean(data) ?? null);
    } catch { /* not JSON after all: fall through */ }
  }
  return TAG.test(t) ? stripHtml(t) : t.replace(/\n{3,}/g, "\n\n");
}

type SpillFn = (a: { turnId: string; toolName: string; text: string; maxChars?: number }) => Promise<string>;
let spillOverride: SpillFn | null | undefined;
/** Test seam: force a spill implementation (null = behave as if turn/spill is absent). */
export const setSpillForTest = (f?: SpillFn | null) => { spillOverride = f; };

async function loadSpill(): Promise<SpillFn | null> {
  if (spillOverride !== undefined) return spillOverride;
  try {
    const spec = "../turn/spill"; // B's module; resolved lazily so D never hard-depends on it
    const m = (await import(/* @vite-ignore */ spec)) as { spillIfLarge?: SpillFn };
    return m.spillIfLarge ?? null;
  } catch { return null; }
}

/** Caps what enters the context: small results pass, big ones become preview + handle (or a noted truncation). */
export async function capResult(text: string, a: { turnId: string; toolName: string }): Promise<string> {
  if (text.length <= MCP_PREVIEW_CHARS) return text;
  const spill = await loadSpill();
  if (spill) {
    try { return await spill({ ...a, text, maxChars: MCP_PREVIEW_CHARS }); }
    catch (e) { log.warn("spill failed, truncating", { error: String(e) }); }
  }
  return text.length <= FALLBACK_CHARS ? text : `${text.slice(0, FALLBACK_CHARS)}\n[truncated: ${text.length - FALLBACK_CHARS} more chars; narrow the request or use fields]`;
}
