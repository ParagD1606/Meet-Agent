import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { channels, memories, users } from "../db/schema";
import { log } from "../log";
import { forgetMemories, rememberFact } from "../memory/facts";
import { deleteMemory, listMemories } from "../memory/graph";
import { decideReview, listReviews, sharedReviews, type Review } from "../memory/review";
import { readTags, SHARED_TAG, writeTag, type SlackScope } from "../memory/scope";
import { ambientCommand } from "./ambient-commands";
import { taskCommand } from "./task-commands";
import { slackClient } from "./client";
import { button, section } from "./cards";
import { escapeSlackText } from "./format";
import { FRESH_START_REPLY, resetContext } from "../turn/reset";
import { listGithubRepositoriesForUser } from "../mcp/github";

export type SlashPayload = { command?: string; text?: string; user_id?: string; channel_id?: string; trigger_id?: string; response_url?: string };
export type Msg = { response_type: "ephemeral"; text: string; blocks?: unknown[]; replace_original?: boolean };
const say = (text: string, blocks?: unknown[]): Msg => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });

const MAX_LIST = 10;
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

async function isAdmin(userId: string): Promise<boolean> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role === "admin" || u?.role === "owner";
}

/** Where a command typed in `channelId` writes. An unknown non-DM channel is treated as private: the narrowest scope, never a leak into shared. */
async function scopeFor(channelId: string, userId: string): Promise<SlackScope> {
  const [c] = await db.select().from(channels).where(eq(channels.id, channelId));
  const isIm = c?.isIm ?? channelId.startsWith("D");
  return { channelId, isIm, isPrivate: c?.isPrivate ?? !isIm, userId };
}

/** Tags this user may delete from: their own user scope, plus shared for admins. */
const deletableTags = (userId: string, admin: boolean) => [`user_${userId}`, ...(admin ? [SHARED_TAG] : [])];

async function remember(p: SlashPayload, userId: string): Promise<Msg> {
  const text = (p.text ?? "").trim();
  if (!text) return say("Usage: `/remember <something worth remembering>`");
  const tag = writeTag(await scopeFor(p.channel_id ?? "", userId));
  if (!tag) return say("I can't tell where to save that.");
  try {
    const r = await rememberFact({ tag, text, source: "slack_command", createdBy: userId, agentContext: "primary" });
    const where = tag === SHARED_TAG ? "for the whole workspace" : tag.startsWith("user_") ? "just for you" : "for this channel";
    return say(r.heldForReview ? "Saved, pending admin review before it goes live." : r.deduped ? "I already knew that." : `Got it, remembered ${where}: ${escapeSlackText(clip(text))}`);
  } catch (err) { return say(escapeSlackText((err as Error).message)); }
}

async function forget(p: SlashPayload, userId: string): Promise<Msg> {
  const query = (p.text ?? "").trim();
  if (!query) return say("Usage: `/forget <what to forget>`");
  const hits = await forgetMemories({ tags: deletableTags(userId, await isAdmin(userId)), query, dryRun: true });
  if (!hits.length) return say("I found nothing matching that among the memories you can delete.");
  const list = hits.map((h) => `• ${escapeSlackText(clip(h.text, 200))} _(${h.scopeTag === SHARED_TAG ? "workspace" : "yours"})_`).join("\n");
  return say(`Delete ${hits.length} memor${hits.length === 1 ? "y" : "ies"}?`, [
    section(`*Delete ${hits.length === 1 ? "this memory" : `these ${hits.length} memories`}?*\n${list}`),
    { type: "actions", elements: [
      button("Delete", "brain_forget_confirm", { style: "danger", value: hits.map((h) => h.id).join(",") }),
      button("Cancel", "brain_forget_cancel"),
    ] },
  ]);
}

/** Facts only (chunks are document text), live rows only: held/pending/rejected never listed. */
async function liveFacts(tags: string[], q?: string) {
  const { items } = await listMemories({ tags, q, limit: 50, offset: 0 });
  return items.filter((m) => m.kind === "fact").slice(0, MAX_LIST);
}

async function whatDoYouKnow(p: SlashPayload, userId: string): Promise<Msg> {
  let q = (p.text ?? "").trim();
  // Another person is just a topic: their name searched over what THIS user may read, never their user-scope facts.
  const mention = q.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (mention) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, mention[1]!));
    q = u?.name ?? mention[1]!;
  }
  const tags = new Set(await readTags(await scopeFor(p.channel_id ?? "", userId)));
  tags.add(`user_${userId}`); // ephemeral reply, so the caller's own scope is always safe to include
  const rows = await liveFacts([...tags], q || undefined);
  if (!rows.length) return say(q ? `I don't know anything about "${escapeSlackText(q)}" that you can see.` : "I don't have any memories you can see yet.");
  return say(`What I know${q ? ` about ${escapeSlackText(q)}` : ""}`, [
    section(`*What I know${q ? ` about ${escapeSlackText(q)}` : ""}* (newest ${rows.length})\n${rows.map((r) => `• ${escapeSlackText(clip(r.text, 250))}`).join("\n")}`),
  ]);
}

// ---- review queue (admins) ----

async function reviewLine(r: Review): Promise<string> {
  const pl = r.payload as Record<string, unknown>;
  if (r.kind === "core_block") return `*${r.kind}* ${pl.op} on ${pl.label} block: ${escapeSlackText(clip(String(pl.text ?? pl.match ?? ""), 200))}`;
  const [m] = r.memoryId == null ? [] : await db.select({ text: memories.text, scopeTag: memories.scopeTag }).from(memories).where(eq(memories.id, r.memoryId));
  return `*${r.kind}*${m ? ` in \`${m.scopeTag}\`` : ""}: ${escapeSlackText(clip(m?.text ?? "(memory removed)", 200))}`;
}

async function reviewView() {
  const pending = (await sharedReviews(await listReviews("pending", 200))).slice(0, 20); // 2 blocks each: stays under the modal's 100-block cap
  const blocks: unknown[] = pending.length ? [] : [section("_Nothing pending. All clear._")];
  for (const r of pending) {
    blocks.push(section(await reviewLine(r)), { type: "actions", elements: [
      button("Approve", "brain_review_approve", { style: "primary", value: r.id }),
      button("Reject", "brain_review_reject", { style: "danger", value: r.id }),
    ] });
  }
  return { type: "modal", title: { type: "plain_text", text: "Memory review" }, close: { type: "plain_text", text: "Close" }, blocks };
}

async function openReview(userId: string, triggerId: string | undefined): Promise<Msg | null> {
  if (!(await isAdmin(userId))) return say("Only workspace admins can review memory changes.");
  if (!triggerId) return say("Couldn't open the review queue; try again.");
  await (await slackClient()).views.open({ trigger_id: triggerId, view: (await reviewView()) as never });
  return null;
}

/** /brain-new: fresh chat history for the DM it is typed in. Slack gives slash commands no thread, so a channel thread says "new chat" instead. */
async function newChat(p: SlashPayload): Promise<Msg> {
  const channel = p.channel_id ?? "";
  const [c] = await db.select().from(channels).where(eq(channels.id, channel));
  if (!(c?.isIm ?? channel.startsWith("D"))) return say('Run `/brain-new` in your DM with me. In a channel thread, reply `@me new chat` there (or start a new thread).');
  await resetContext(channel, "dm");
  return say(FRESH_START_REPLY);
}

/** Personal and ephemeral by design: a Slack command never reveals another member's repositories. */
async function repos(p: SlashPayload, userId: string): Promise<Msg> {
  const raw = (p.text ?? "").trim();
  if (raw && !/^\d+$/.test(raw)) return say("Usage: `/repos` or `/repos 2` for the next page.");
  try {
    const result = await listGithubRepositoriesForUser(userId, raw ? Number(raw) : 1);
    if (!result) return say("Connect your personal GitHub account first in Company Brain → Integrations → GitHub.");
    if (!result.repositories.length) return say("No repositories were returned on this page. Try `/repos 1`.");
    const more = result.next_page ? `\n\nMore repositories are available: run \`/repos ${result.next_page}\`.` : "";
    return say(`*Your GitHub repositories — page ${result.page}*\n${result.repositories.map((name) => `• \`${escapeSlackText(name)}\``).join("\n")}${more}`);
  } catch (err) {
    const message = err instanceof Error && /McpReauthRequired/.test(err.name) ? "Your GitHub connection needs to be reconnected in Integrations." : "Could not load your GitHub repositories. Try again or reconnect GitHub in Integrations.";
    return say(message);
  }
}

// ---- entrypoints ----

/** Runs a slash command and returns the ephemeral reply (null when a modal was opened instead). */
export async function runSlashCommand(p: SlashPayload): Promise<Msg | null> {
  const userId = p.user_id;
  if (!userId) return null;
  const amb = await ambientCommand(p); if (amb) return amb; // /brain-pause, /brain-resume
  const tsk = await taskCommand(p); if (tsk) return tsk; // /brain-tasks, /brain-followups
  switch (p.command) {
    case "/remember": return remember(p, userId);
    case "/forget": return forget(p, userId);
    case "/whatdoyouknow": return whatDoYouKnow(p, userId);
    case "/brain-review": return openReview(userId, p.trigger_id);
    case "/brain-new": return newChat(p);
    case "/repos": return repos(p, userId);
    default: return say("Unknown command.");
  }
}

/** Delayed reply through Slack's response_url (commands outlive the 3s ack: embedding + contradiction check). */
export async function respond(url: string | undefined, msg: Msg): Promise<void> {
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }); }
  catch (err) { log.warn("slack response_url failed", { error: (err as Error).message }); }
}

/** Fire-and-forget after the transport acked: run, then post the reply. Never throws. */
export async function handleSlashCommand(p: SlashPayload): Promise<void> {
  try {
    const msg = await runSlashCommand(p);
    if (msg) await respond(p.response_url, msg);
  } catch (err) {
    log.error("slash command failed", { command: p.command, error: (err as Error).message });
    await respond(p.response_url, say("Something went wrong, please try again."));
  }
}

type BlockPayload = { user?: { id?: string }; trigger_id?: string; response_url?: string; view?: { id?: string } };

/** Deletes the `ids` this user may delete (re-checked here: button values are client-controlled). Returns the count. */
async function deleteOwned(userId: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const allowed = new Set(deletableTags(userId, await isAdmin(userId)));
  const rows = await db.select({ id: memories.id, scopeTag: memories.scopeTag }).from(memories).where(inArray(memories.id, ids));
  let n = 0;
  for (const r of rows) if (allowed.has(r.scopeTag) && (await deleteMemory(r.id))) n++;
  return n;
}

/** Brain buttons from commands, the review modal and App Home. Returns false when the action is not ours. */
export async function handleBrainAction(payload: BlockPayload, a: { action_id?: string; value?: string }): Promise<boolean> {
  const userId = payload.user?.id;
  if (!userId) return false;
  switch (a.action_id) {
    case "brain_forget_confirm": {
      const n = await deleteOwned(userId, (a.value ?? "").split(",").map(Number).filter(Number.isInteger));
      await respond(payload.response_url, { ...say(n ? `Deleted ${n} memor${n === 1 ? "y" : "ies"}.` : "Nothing was deleted."), blocks: [], replace_original: true });
      return true;
    }
    case "brain_forget_cancel":
      await respond(payload.response_url, { ...say("Cancelled."), blocks: [], replace_original: true });
      return true;
    case "brain_home_forget": {
      await deleteOwned(userId, [Number(a.value)].filter(Number.isInteger));
      const { onAppHome } = await import("./onboarding"); // lazy: onboarding imports homeFacts from here
      await onAppHome(userId);
      return true;
    }
    case "brain_review_open": {
      const m = await openReview(userId, payload.trigger_id);
      if (m) await respond(payload.response_url, m); // App Home has no response_url; only admins are shown the button
      return true;
    }
    case "brain_review_approve":
    case "brain_review_reject": {
      if (!(await isAdmin(userId))) return true;
      const r = await decideReview(a.value ?? "", userId, a.action_id === "brain_review_approve");
      if (!r.ok) log.info("review decision failed", { id: a.value, error: r.error });
      if (payload.view?.id) await (await slackClient()).views.update({ view_id: payload.view.id, view: (await reviewView()) as never });
      return true;
    }
    default: return false;
  }
}

/** The user's own live facts for the App Home section. */
export async function homeFacts(userId: string): Promise<{ id: number; text: string }[]> {
  return (await liveFacts([`user_${userId}`])).map((m) => ({ id: m.id, text: m.text }));
}
