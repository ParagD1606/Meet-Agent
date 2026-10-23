/** Markdown (LLM output) -> Slack mrkdwn, plus length-safe chunking. */

const SLACK_TEXT_LIMIT = 3000; // section-block safe; chat.postMessage `text` tolerates ~40k but blocks do not

export const escapeSlackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toMrkdwn(md: string): string {
  const stash: string[] = [];
  const hold = (s: string) => `\u0000${stash.push(s) - 1}\u0000`;
  let out = md
    // fenced + inline code are opaque
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => hold("```\n" + escapeSlackText(code.replace(/\n$/, "")) + "\n```"))
    .replace(/`([^`\n]+)`/g, (_m, code: string) => hold("`" + escapeSlackText(code) + "`"))
    // links + images
    .replace(/!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
      hold(label ? `<${url}|${escapeSlackText(label)}>` : `<${url}>`));
  // already-formed Slack tokens (<@U1>, <#C1>, <!here>) are kept verbatim
  out = out.replace(/<([@#!][^>\s]*|https?:\/\/[^>\s]+)>/g, (m) => hold(m));
  out = escapeSlackText(out)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/^---+$/gm, "──────");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

/** Split on paragraph/line/space boundaries so no chunk exceeds `max`; keeps ``` fences balanced. */
export function chunkText(text: string, max = SLACK_TEXT_LIMIT): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  let openFence = false;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < max * 0.5) cut = max;
    let piece = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    const fences = (piece.match(/```/g) ?? []).length;
    if (openFence) piece = "```\n" + piece;
    if ((fences % 2 === 1) !== openFence) { piece += "\n```"; openFence = true; } else openFence = false;
    chunks.push(piece);
  }
  if (rest) chunks.push(openFence ? "```\n" + rest : rest);
  return chunks;
}
