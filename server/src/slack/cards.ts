import { config } from "../config";
import { escapeSlackText } from "./format";
import type { JourneyRung } from "./journey/rungs";

export type Card = { text: string; blocks: unknown[] };

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const link = (path: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}${path}`;
const button = (text: string, actionId: string, extra: Record<string, unknown> = {}) =>
  ({ type: "button", text: { type: "plain_text", text }, action_id: actionId, ...extra });

export function welcomeCard(name?: string | null): Card {
  const hi = name ? `Hi ${escapeSlackText(name.split(" ")[0]!)}!` : "Hi!";
  const text = `${hi} I'm Company Brain: a teammate that remembers what your team decides and can act on your tools. DM me or @mention me in any channel I'm in.`;
  return {
    text,
    blocks: [
      section(`*${hi}* I'm Company Brain, a teammate that remembers what your team decides and can act on your tools.`),
      section("• Ask me anything: _\"what did we decide about pricing?\"_\n• I quietly note decisions and owners from channels I'm in\n• Say _\"remind me…\"_ or _\"every Monday, send a digest of…\"_"),
      { type: "actions", elements: [button("Connect your tools", "brain_open_dashboard", { url: link("/configure/integrations") })] },
    ],
  };
}

export function channelIntroCard(): Card {
  const text = "Hi, I'm Company Brain. I keep up with this channel and remember decisions, owners and deadlines. @mention me to ask anything; I'll only chime in unprompted when I can genuinely help.";
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
  first_ask: { text: "Try asking me something: DM me _\"what do we know about <topic>?\"_ and I'll search everything the team has told me.", cta: "Open the dashboard", path: "/" },
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

export function homeView(o: { name?: string | null; connections: number }): unknown {
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Company Brain" } },
      section(`${o.name ? `Welcome back, ${escapeSlackText(o.name.split(" ")[0]!)}.` : "Welcome."} DM me or @mention me in a channel to get started.`),
      section(o.connections > 0 ? `*${o.connections}* connected tool${o.connections === 1 ? "" : "s"} available to me.` : "_No tools connected yet._"),
      { type: "actions", elements: [
        button("Dashboard", "brain_open_dashboard", { url: link("/") }),
        button("Connect tools", "brain_open_dashboard", { url: link("/configure/integrations") }),
      ] },
    ],
  };
}
