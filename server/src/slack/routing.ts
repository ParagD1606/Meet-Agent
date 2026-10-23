/** Pure message routing: what should Company Brain do with this Slack `message`/`app_mention` event? */

export type SlackFileRef = import("./attachments").SlackFile;

export type SlackMessageEvent = {
  type: "message" | "app_mention";
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  channel_type?: "channel" | "group" | "im" | "mpim";
  files?: SlackFileRef[];
};

export type Route =
  | { kind: "ignore"; reason: string }
  | { kind: "turn"; trigger: "mention" | "dm" }
  | { kind: "triage"; context: "thread" | "channel" };

// Subtypes that carry a real human utterance. Everything else (edits, joins, bot_message, ...) is noise.
const HUMAN_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

export const mentionToken = (botUserId: string) => `<@${botUserId}>`;

export function stripMention(text: string, botUserId: string): string {
  return text.split(mentionToken(botUserId)).join("").replace(/\s+/g, " ").trim();
}

export function routeMessage(ev: SlackMessageEvent, botUserId: string, o: { botInThread: boolean }): Route {
  if (ev.bot_id || !ev.user) return { kind: "ignore", reason: "bot_or_system" };
  if (ev.user === botUserId) return { kind: "ignore", reason: "self" };
  if (!HUMAN_SUBTYPES.has(ev.subtype)) return { kind: "ignore", reason: `subtype:${ev.subtype}` };
  if (!ev.text?.trim() && !ev.files?.length) return { kind: "ignore", reason: "empty" };
  if (ev.channel_type === "im") return { kind: "turn", trigger: "dm" };
  if (ev.type === "app_mention" || ev.text?.includes(mentionToken(botUserId))) return { kind: "turn", trigger: "mention" };
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    return o.botInThread ? { kind: "triage", context: "thread" } : { kind: "ignore", reason: "thread_without_bot" };
  }
  return { kind: "triage", context: "channel" };
}
