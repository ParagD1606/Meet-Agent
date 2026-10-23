import { safeFetch } from "./ssrf";

const MAX_CHARS = 25_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Readability-lite: drop chrome, prefer <article>/<main>, keep paragraph/heading/list breaks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "");
  const main = h.match(/<article\b[\s\S]*?<\/article>/i) ?? h.match(/<main\b[\s\S]*?<\/main>/i);
  if (main) h = main[0];
  else h = h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, "");
  const text = decode(
    h
      .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => "\n\n" + "#".repeat(Number(n)) + " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|section|tr|h[1-6]|ul|ol|table|blockquote)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export type Extracted = { url: string; title: string; text: string; truncated: boolean };

/** Fetch a public URL and return readable text. Throws on SSRF violations, non-text content, or fetch failure. */
export async function extractUrl(url: string): Promise<Extracted> {
  const res = await safeFetch(url, { maxBytes: 2_000_000, timeoutMs: 15_000 });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const ct = res.contentType.toLowerCase();
  const raw = new TextDecoder().decode(res.body);
  let title = "";
  let text: string;
  if (ct.includes("html") || ct === "") ({ title, text } = htmlToText(raw));
  else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) text = raw;
  else throw new Error(`unsupported content type: ${ct}`);
  const clipped = text.length > MAX_CHARS;
  return { url: res.url, title, text: clipped ? text.slice(0, MAX_CHARS) : text, truncated: clipped || res.truncated };
}
