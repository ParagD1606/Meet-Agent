/**
 * Output sanitiser for anything the bot posts that a model (or injected content) influenced.
 * Run it on raw model text BEFORE toMrkdwn/chunkText.
 *  - broadcast mentions (<!channel>, <!here>, <!everyone>, <!subteam^...>, <!date...>) become inert words
 *  - Slack link markup is reduced to what is safe: <@U>, <#C>, and bare <https://url> survive;
 *    <url|label> becomes "label (url)" so the real destination is always visible (no hidden phishing label)
 *  - markdown links whose label itself looks like a different URL are flattened to the URL
 *  - any other <...> token loses its angle brackets
 */
const WORD: Record<string, string> = { channel: "channel", here: "here", everyone: "everyone" };

/** One <...> token (no nested '<', no newline, bounded). Returns its replacement. */
function rewriteToken(m: string, inner: string): string {
  if (inner.startsWith("!")) {
    const kind = inner.slice(1).split("|")[0]!;
    const k = kind.split("^")[0]!.trim().toLowerCase();
    return WORD[k] ?? (k === "subteam" ? "group" : k);
  }
  if (/^@[UW][A-Z0-9]+$/.test(inner) || /^#C[A-Z0-9]+(\|[^<>|]{0,80})?$/.test(inner)) return m;
  const [target, ...rest] = inner.split("|");
  if (/^https?:\/\/\S+$/i.test(target!)) {
    const label = rest.join("|").trim();
    return label && label !== target ? `${label} (${target})` : `<${target}>`;
  }
  return inner;
}

export function sanitizeForSlack(text: string): string {
  // Single forward scan: each '>' / '<' search only moves forward and a failed search is remembered, so input like
  // "<<<<<<" or "<!<!<!" stays O(n) (the regex version rescanned to the end of the string per '<').
  let out = "";
  let i = 0, noGt = false;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { out += text.slice(i); break; }
    out += text.slice(i, lt);
    const gt = noGt ? -1 : text.indexOf(">", lt + 1);
    if (gt < 0) { noGt = true; out += text.slice(lt); break; }
    if (gt - lt > 2001) { out += "<"; i = lt + 1; continue; }
    const inner = text.slice(lt + 1, gt);
    if (inner.includes("<") || inner.includes("\n")) { out += "<"; i = lt + 1; continue; }
    out += rewriteToken(text.slice(lt, gt + 1), inner);
    i = gt + 1;
  }
  // [https://good.example](https://evil.example) style label spoofing
  return out.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) =>
    /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b)/i.test(label) && !label.includes(url) ? url : m);
}
