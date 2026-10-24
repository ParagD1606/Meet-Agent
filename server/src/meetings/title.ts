const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const decodeEntities = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * Slack names Huddle canvases ":headphones: Huddle notes: 10/24/26 in &lt;#C0123ABC&gt;". Turns that (and any other
 * title carrying entities, emoji codes or channel mentions) into "Huddle in #general · Oct 24".
 * Idempotent, so it is safe on already-clean titles. `channelName` is the stored name for the meeting's channel.
 */
export function cleanTitle(raw: string, channelName?: string | null, fallbackDate?: Date | string | null): string {
  let t = decodeEntities(raw).replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/gi, "$1").replace(/\s+/g, " ").trim();
  const mention = /<#([A-Z0-9]+)(?:\|([^>]+))?>/.exec(t);
  const channel = (mention?.[2] ?? channelName ?? "").replace(/^#/, "").trim();
  t = t.replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/g, channel ? `#${channel}` : "a channel");
  const huddle = /^huddle (?:notes|transcript)\b:?\s*(.*)$/i.exec(t);
  if (!huddle) return t || "Meeting";
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(huddle[1]!);
  const d = fallbackDate ? new Date(fallbackDate) : null;
  const date = m ? `${MONTHS[Number(m[1]) - 1] ?? ""} ${Number(m[2])}`.trim()
    : d && !Number.isNaN(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "";
  return ["Huddle" + (channel ? ` in #${channel}` : ""), date].filter(Boolean).join(" · ");
}

