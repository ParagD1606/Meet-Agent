import { config } from "../config";
import { escapeSlackText } from "./format";
import type { JourneyRung } from "./journey/rungs";

export type Card = { text: string; blocks: unknown[] };

export const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const link = (path: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}${path}`;
export const button = (text: string, actionId: string, extra: Record<string, unknown> = {}) =>
  ({ type: "button", text: { type: "plain_text", text }, action_id: actionId, ...extra });

export function welcomeCard(name?: string | null, bot = "Pixel"): Card {
  const hi = name ? `Hi ${escapeSlackText(name.split(" ")[0]!)}!` : "Hi!";
  const text = `${hi} I'm ${escapeSlackText(bot)}, your teammate on Company Brain. I remember what you tell me and can use the tools you connect. DM me or @mention me in any channel I've been added to.`;
  return {
    text,
    blocks: [
      section(`*${hi}* I'm ${escapeSlackText(bot)}, your teammate on Company Brain. I remember what you tell me and can use the tools you connect.`),
      section("• Ask me anything: _\"what did we decide about pricing?\"_ (I only know what I've been told or connected to)\n• I save decisions and owners from conversations I'm part of; an admin can opt channels in to learn from more\n• Say _\"remind me…\"_ or _\"every Monday, send a digest of…\"_"),
      { type: "actions", elements: [button("Connect your tools", "brain_open_dashboard", { url: link("/configure/integrations") })] },
    ],
  };
}

export function channelIntroCard(bot = "Pixel"): Card {
  const text = `Hi, I'm ${escapeSlackText(bot)}. @mention me to ask anything or to save a decision, owner or deadline. I stay quiet here unless an admin has turned on proactive replies, and I only learn from this channel's history if an admin opts it in.`;
  return { text, blocks: [section(text)] };
}

export function teamInviteCard(): Card {
  const text = `Company Brain is installed. Invite your teammates: ask them to join #company-brain, or share ${link("/")} so they can sign in to the dashboard.`;
  return {
    text,
    blocks: [
      section("*Company Brain is live.* Bring your team in so the memory covers more than just you:"),
      section("1. Ask teammates to join *#company-brain*\n2. Share the dashboard so they can sign in with Slack"),
      { type: "actions", elements: [button("Open dashboard", "brain_open_dashboard", { url: link("/"), style: "primary" })] },
    ],
  };
}

const NUDGES: Record<JourneyRung, { text: string; cta: string; path: string }> = {
  connect_tool: { text: "Connect a tool (GitHub, Linear, Notion, Google...) and I can answer from, and act in, the systems you already use.", cta: "Connect a tool", path: "/configure/integrations" },
  first_ask: { text: "Try asking me something: DM me _\"what do we know about <topic>?\"_ and I'll search what the team has told me and the tools you've connected.", cta: "Open the dashboard", path: "/" },
  automation: { text: "Want a standing digest or reminder? Tell me _\"every Monday 9am, summarize what moved last week in #product\"_ and I'll schedule it.", cta: "See automations", path: "/configure/automations" },
};

export function nudgeCard(rung: JourneyRung): Card {
  const n = NUDGES[rung];
  return {
    text: n.text,
    blocks: [
      section(n.text),
      { type: "actions", elements: [
        button(n.cta, "brain_open_dashboard", { url: link(n.path) }),
        button("Not now / stop tips", "journey_quiet", { value: rung }),
      ] },
    ],
  };
}

export function homeView(o: { botName?: string; name?: string | null; connections: number; facts?: { id: number; text: string }[]; admin?: boolean }): unknown {
  const facts = o.facts ?? [];
  const confirm = { title: { type: "plain_text", text: "Delete this memory?" }, text: { type: "plain_text", text: "I will forget it for good." }, confirm: { type: "plain_text", text: "Delete" }, deny: { type: "plain_text", text: "Keep" } };
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: o.botName ? `${o.botName} · Company Brain` : "Company Brain" } },
      section(`${o.name ? `Welcome back, ${escapeSlackText(o.name.split(" ")[0]!)}.` : "Welcome."} DM me or @mention me in a channel to get started.`),
      section(o.connections > 0 ? `*${o.connections}* connected tool${o.connections === 1 ? "" : "s"} available to me.` : "_No tools connected yet._"),
      { type: "actions", elements: [
        button("Dashboard", "brain_open_dashboard", { url: link("/") }),
        button("Connect tools", "brain_open_dashboard", { url: link("/configure/integrations") }),
        ...(o.admin ? [button("Review queue", "brain_review_open")] : []),
      ] },
      { type: "header", text: { type: "plain_text", text: "What I remember about you" } },
      ...(facts.length
        ? facts.map((f) => ({
            ...section(escapeSlackText(f.text.length > 300 ? `${f.text.slice(0, 297)}...` : f.text)),
            accessory: button("Delete", "brain_home_forget", { value: String(f.id), style: "danger", confirm }),
          }))
        : [section("_Nothing yet. Try `/remember <something>`._")]),
    ],
  };
}
