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

export function sanitizeForSlack(text: string): string {
  let out = text.replace(/<!([^>|]*)(?:\|[^>]*)?>/g, (_m, kind: string) => {
    const k = kind.split("^")[0]!.trim().toLowerCase();
    return WORD[k] ?? (k === "subteam" ? "group" : k || "");
  });
  out = out.replace(/<([^<>\n]{1,2000})>/g, (m, inner: string) => {
    if (/^@[UW][A-Z0-9]+$/.test(inner) || /^#C[A-Z0-9]+(\|[^<>|]{0,80})?$/.test(inner)) return m;
    const [target, ...rest] = inner.split("|");
    if (/^https?:\/\/\S+$/i.test(target!)) {
      const label = rest.join("|").trim();
      return label && label !== target ? `${label} (${target})` : `<${target}>`;
    }
    return inner.replace(/[<>]/g, "");
  });
  // [https://good.example](https://evil.example) style label spoofing
  out = out.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) =>
    /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b)/i.test(label) && !label.includes(url) ? url : m);
  return out;
}
