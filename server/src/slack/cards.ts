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
  const facts = (o.facts ?? []).filter((f) => f.text.trim()).slice(0, 40); // a Home tab allows 100 blocks; a blank section text makes Slack reject the whole view
  const confirm = { title: { type: "plain_text", text: "Delete this memory?" }, text: { type: "plain_text", text: "I will forget it for good." }, confirm: { type: "plain_text", text: "Delete" }, deny: { type: "plain_text", text: "Keep" } };
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: o.botName ? `${o.botName} · Company Brain` : "Company Brain" } },
      section(`${o.name ? `Welcome back, ${escapeSlackText(o.name.split(" ")[0]!)}.` : "Welcome."} DM me or @mention me in a channel to get started.`),
      section(o.connections > 0 ? `*${o.connections}* connected tool${o.connections === 1 ? "" : "s"} available to me.` : "_No tools connected yet._"),
      { type: "actions", elements: [
        button("Dashboard", "brain_open_dashboard", { url: link("/") }),
        button("Connect tools", "brain_open_integrations", { url: link("/configure/integrations") }),
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

/** "Resolved / Not quite" buttons under a bot answer. value carries the asker, the question and the thread so the click needs no lookups. */
export function resolveActions(v: { u: string; q: string; t?: string | null }): unknown[] {
  const value = JSON.stringify({ u: v.u, q: v.q.slice(0, 400), t: v.t ?? null });
  return [{ type: "actions", elements: [button("Resolved", "brain_resolve_yes", { value, style: "primary" }), button("Not quite", "brain_resolve_no", { value })] }];
}

/** Consent card: the asker sees the exact question text that will be sent to the teammate. */
export function askConfirmCard(a: { id: string; owner: string; question: string }): Card {
  const text = `I can't answer that from memory. Want me to ask <@${a.owner}>? I'll send only this question: "${escapeSlackText(a.question)}"`;
  return { text, blocks: [section(text), { type: "actions", elements: [button("Ask them", "brain_ask_yes", { value: a.id, style: "primary" }), button("No thanks", "brain_ask_no", { value: a.id })] }] };
}

/** Generic "confirm this write" card for actions the model proposed after untrusted text entered the turn. Only the asker's click counts. */
export function confirmWriteCard(a: { id: string; summary: string }): Card {
  const text = `Outside text (a document, another person's message or a web page) was part of this request, so I won't act on it without your OK. Do this? ${escapeSlackText(a.summary)}`;
  return { text, blocks: [section(text), { type: "actions", elements: [button("Confirm", "brain_cw_yes", { value: a.id, style: "primary" }), button("Cancel", "brain_cw_no", { value: a.id })] }] };
}

/** Consent card for "follow up with @X": the requester sees the exact text and time before anyone is messaged. */
export function followUpConfirmCard(a: { id: string; target: string; text: string; at: Date; repeatDays?: number | null }): Card {
  const when = `${a.at.toISOString().slice(0, 16).replace("T", " ")} UTC${a.repeatDays ? `, then every ${a.repeatDays} day(s)` : ""}`;
  const text = `Want me to follow up with <@${a.target}> on ${when}? I'll DM them only this: "${escapeSlackText(a.text)}"`;
  return { text, blocks: [section(text), { type: "actions", elements: [button("Yes, follow up", "brain_fu_yes", { value: a.id, style: "primary" }), button("No thanks", "brain_fu_no", { value: a.id })] }] };
}
