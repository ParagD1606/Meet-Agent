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

type Tok = { text: string } | { tag: string; close: boolean };

const ascii = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isNameChar = (c: string) => /[a-z0-9:-]/.test(c);
// elements whose whole content is dropped
const OPAQUE = new Set(["script", "style", "noscript", "svg", "template", "iframe"]);
const CHROME = new Set(["nav", "header", "footer", "aside", "form"]);

/**
 * Single left-to-right pass: every index search only moves forward and a failed search (no closing '>' or
 * closing tag anywhere ahead) is remembered, so hostile input like "<a<a<a<a..." stays O(n).
 */
function tokenize(html: string): Tok[] {
  const lower = ascii(html);
  const toks: Tok[] = [];
  let i = 0, noGt = false, noComment = false;
  const closeMissing = new Set<string>();
  const pushText = (t: string) => { if (t) toks.push({ text: t }); };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = noComment ? -1 : html.indexOf("-->", lt + 4);
      if (end < 0) { noComment = true; break; } // unterminated comment swallows the rest, like browsers
      i = end + 3;
      continue;
    }
    const closing = html[lt + 1] === "/";
    let j = lt + (closing ? 2 : 1);
    const nameStart = j;
    while (j < html.length && isNameChar(lower[j]!)) j++;
    if (j === nameStart) { pushText("<"); i = lt + 1; continue; } // a bare '<' in text
    const name = lower.slice(nameStart, j);
    const gt = noGt ? -1 : html.indexOf(">", j);
    if (gt < 0) { noGt = true; pushText(html.slice(lt)); break; }
    i = gt + 1;
    if (!closing && OPAQUE.has(name)) {
      const endTag = `</${name}`;
      const k = closeMissing.has(name) ? -1 : lower.indexOf(endTag, i);
      if (k < 0) { closeMissing.add(name); break; } // unclosed: drop the rest
      const kg = html.indexOf(">", k);
      i = kg < 0 ? html.length : kg + 1;
      continue;
    }
    toks.push({ tag: name, close: closing });
  }
  return toks;
}

/** Marks tokens inside balanced <nav>/<header>/<footer>/<aside>/<form> pairs (unbalanced openers are left alone). */
function chromeMask(toks: Tok[]): boolean[] {
  const skip = new Array<boolean>(toks.length).fill(false);
  const stacks = new Map<string, number[]>();
  toks.forEach((t, idx) => {
    if (!("tag" in t) || !CHROME.has(t.tag)) return;
    const st = stacks.get(t.tag) ?? [];
    stacks.set(t.tag, st);
    if (!t.close) st.push(idx);
    else if (st.length) {
      const open = st.pop()!;
      if (!st.length) for (let k = open; k <= idx; k++) skip[k] = true; // outermost pair only
    }
  });
  return skip;
}

/** Readability-lite: drop chrome, prefer <article>/<main>, keep paragraph/heading/list breaks. Linear time. */
export function htmlToText(html: string): { title: string; text: string } {
  let toks = tokenize(html);

  let title = "";
  const ti = toks.findIndex((t) => "tag" in t && t.tag === "title" && !t.close);
  if (ti >= 0) {
    let k = ti + 1, raw = "";
    for (; k < toks.length && !("tag" in toks[k]! && (toks[k] as { tag: string }).tag === "title"); k++) {
      const t = toks[k]!;
      if ("text" in t) raw += t.text;
    }
    title = decode(raw.trim());
  }
  const region = (name: string) => {
    const o = toks.findIndex((t) => "tag" in t && t.tag === name && !t.close);
    if (o < 0) return null;
    const c = toks.findIndex((t, idx) => idx > o && "tag" in t && t.tag === name && t.close);
    return toks.slice(o + 1, c < 0 ? undefined : c);
  };
  const main = region("article") ?? region("main");
  let out = "";
  if (main) toks = main;
  const skip = main ? new Array<boolean>(toks.length).fill(false) : chromeMask(toks);
  toks.forEach((t, idx) => {
    if (skip[idx]) return;
    if ("text" in t) { out += t.text; return; }
    if (t.close) { if (/^(p|div|section|tr|h[1-6]|ul|ol|table|blockquote)$/.test(t.tag)) out += "\n"; return; }
    if (/^h[1-6]$/.test(t.tag)) out += "\n\n" + "#".repeat(Number(t.tag[1])) + " ";
    else if (t.tag === "li") out += "\n- ";
    else if (t.tag === "br") out += "\n";
  });
  const text = decode(out)
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
