import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { channels, turns } from "../db/schema";
import { log } from "../log";
import { claimEvent } from "./dedupe";
import { handleChannelMessage } from "./chime";
import { botUserId, getWorkspace, postMessage, slackClient } from "./client";
import { deps } from "./deps";
import { introduceInChannel, onAppHome, onUserJoined } from "./onboarding";
import { ratingFor, recordFeedback, ack, done } from "./reactions";
import { readSlackFiles } from "./attachments";
import { resolvePrivacy, routeMessage, stripMention, type SlackMessageEvent } from "./routing";
import { onAssistantThreadStarted, noteAssistantMessage, isAssistantThread } from "./assistant";
import { begin, drain, end, gateKey, mergeInbox, setActiveText, signalOf } from "./active-turn-gate";
import { steerActive } from "../turn/steering";
import { handleWorkspaceGone } from "./lifecycle";
import { dropChannel, ensureChannel, ensureUser, setMembership, upsertChannel, upsertSlackUser } from "./sync";
import { ingestHuddleFile } from "../meetings";
import { captureOwnerReply } from "./teammate";

export { claimEvent, pruneEvents } from "./dedupe";
export type EventCallback = { event_id?: string; team_id?: string; type?: string; event?: Record<string, any> };

/** Event channel_type if present, else our channel row, else conversations.info; unknown => private. */
async function privacyOf(ev: SlackMessageEvent): Promise<{ isPrivate: boolean; isIm: boolean }> {
  if (ev.channel_type) {
    const [row] = await db.select().from(channels).where(eq(channels.id, ev.channel));
    return resolvePrivacy(ev.channel_type, row ? { isPrivate: row.isPrivate, isIm: row.isIm } : null);
  }
  const [row] = await db.select().from(channels).where(eq(channels.id, ev.channel));
  if (row) return resolvePrivacy(undefined, { isPrivate: row.isPrivate, isIm: row.isIm });
  try {
    const c = (await (await slackClient()).conversations.info({ channel: ev.channel })).channel;
    if (c) return resolvePrivacy(undefined, { isPrivate: Boolean(c.is_private || c.is_mpim), isIm: Boolean(c.is_im) });
  } catch (err) { log.warn("channel privacy unknown; treating as private", { channel: ev.channel, error: (err as Error).message }); }
  return resolvePrivacy(undefined, null);
}

async function botInThread(channel: string, threadTs: string): Promise<boolean> {
  const [row] = await db.select({ id: turns.id }).from(turns).where(and(eq(turns.channelId, channel), eq(turns.threadTs, threadTs))).limit(1);
  return Boolean(row);
}

async function handleMessage(ev: SlackMessageEvent): Promise<void> {
  const me = await botUserId();
  const route = routeMessage(ev, me, { botInThread: ev.thread_ts && ev.thread_ts !== ev.ts ? await botInThread(ev.channel, ev.thread_ts) : false });
  if (ev.type === "app_mention" || route.kind === "turn") {
    log.info("slack mention routed", {
      eventType: ev.type,
      route: route.kind,
      ...(route.kind === "turn" ? { trigger: route.trigger } : {}),
      ...(route.kind === "ignore" ? { reason: route.reason } : {}),
    });
  }
  // an owner answering a question Pixel routed to them is consumed here (stored + relayed), not run as a turn
  if (ev.type === "message" && !ev.bot_id && ev.user !== me && await captureOwnerReply(ev).catch((e) => { log.warn("owner reply capture failed", { error: String(e) }); return false; })) return;
  if (route.kind === "ignore") return;
  // The same human message can arrive as both `message` and `app_mention`; process it once.
  if (!(await claimEvent(`m:${ev.channel}:${ev.ts}`))) return;

  const { isIm, isPrivate } = await privacyOf(ev);
  // A `message` event is only delivered for channels the bot is in, so it doubles as a membership signal.
  if (ev.type === "message" && !isIm) await upsertChannel({ id: ev.channel, isPrivate, isIm: false, botIsMember: true });
  else await ensureChannel({ id: ev.channel, isIm, isPrivate });
  if (ev.user) await ensureUser(ev.user);
  const [ch] = await db.select().from(channels).where(eq(channels.id, ev.channel));

  if (route.kind === "triage") {
    await handleChannelMessage(ev, { context: route.context, botUserId: me, channelName: ch?.name ?? undefined, isPrivate: Boolean(ch?.isPrivate) || isPrivate });
    return;
  }
  await runUserTurn(ev, route.trigger, me, Boolean(ch?.isPrivate) || isPrivate, Boolean(ch?.isIm) || isIm);
}

/** Huddle notes can be announced as a regular channel message containing a canvas file. */
async function ingestHuddleAttachments(ev: SlackMessageEvent): Promise<void> {
  for (const file of ev.files ?? []) {
    if (!file.id) continue;
    try {
      const imported = await ingestHuddleFile(file.id, ev.channel);
      if (imported) log.info("huddle imported from message attachment", { fileId: file.id, channelId: ev.channel });
    } catch (err) {
      log.warn("huddle attachment import failed", { fileId: file.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function runUserTurn(ev: SlackMessageEvent, trigger: "mention" | "dm", me: string, isPrivate: boolean, isIm: boolean) {
  const files = await readSlackFiles(ev.files);
  const text = stripMention(ev.text ?? "", me);
  const threadTs = isIm ? ev.thread_ts : (ev.thread_ts ?? ev.ts);
  const key = gateKey(ev.channel, threadTs ?? "dm");
  const assistant = isIm && isAssistantThread(ev.channel, threadTs);
  if (assistant) void noteAssistantMessage(ev.channel, threadTs, text);

  // A turn is already running in this thread: steer it (stop / replace / ignore) or queue this message for one merged follow-up.
  while (!begin(key, { userId: ev.user ?? null, text })) {
    const s = await steerActive(key, { userId: ev.user ?? null, ts: ev.ts, text, files });
    if (!s.handled) continue; // the turn ended while we were deciding: try to start ours
    if (s.action === "APPEND" && s.notice) {
      await postMessage({ channel: ev.channel, thread_ts: threadTs ?? ev.thread_ts, text: "_Got your message. I'll pick it up as soon as I finish this one._" })
        .catch((e) => log.warn("queue notice failed", { error: (e as Error).message }));
    }
    return;
  }
  try {
    await ack(ev.channel, ev.ts);
    let ok = await runOne({ trigger, channelId: ev.channel, threadTs, ts: ev.ts, userId: ev.user ?? null, text, isPrivate, isIm, assistant, actionToken: ev.action_token, abortSignal: signalOf(key), ...(files.length ? { files } : {}) });
    for (let batch = drain(key); batch.length; batch = drain(key)) {
      const m = mergeInbox(batch);
      setActiveText(key, { userId: m.userId, text: m.text });
      ok = (await runOne({ trigger, channelId: ev.channel, threadTs, ts: m.ts, userId: m.userId, text: m.text, isPrivate, isIm, assistant, abortSignal: signalOf(key), ...(m.files.length ? { files: m.files } : {}) })) && ok;
    }
    await done(ev.channel, ev.ts, ok);
  } finally { end(key); }
}

async function runOne(input: Parameters<typeof deps.runTurn>[0]): Promise<boolean> {
  try { await deps.runTurn(input); return true; }
  catch (err) { log.error("turn failed", { channel: input.channelId, trigger: input.trigger, error: (err as Error).message }); return false; }
}

async function handleReaction(ev: Record<string, any>): Promise<void> {
  const rating = ratingFor(String(ev.reaction ?? ""));
  if (!rating || ev.item?.type !== "message" || !ev.user) return;
  if (ev.user === (await botUserId()) || ev.item_user !== (await botUserId())) return; // only humans rating bot messages
  // the reaction event does not say which thread the message is in; ask Slack (best effort, falls back to a time window)
  const threadTs = await slackClient().then((c) => c.reactions.get({ channel: ev.item.channel, timestamp: ev.item.ts }))
    .then((r) => (r.message as { thread_ts?: string } | undefined)?.thread_ts ?? null).catch(() => null);
  await recordFeedback({ channelId: ev.item.channel, messageTs: ev.item.ts, userId: ev.user, rating, threadTs });
}

async function handleMemberJoined(ev: Record<string, any>): Promise<void> {
  if (!ev.channel || !ev.user) return;
  const me = await botUserId();
  if (ev.user === me) {
    await ensureChannel({ id: ev.channel, isPrivate: ev.channel_type === "G" });
    await upsertChannel({ id: ev.channel, botIsMember: true });
    const { syncChannelMembers } = await import("./sync");
    await syncChannelMembers(await slackClient(), ev.channel).catch((e) => log.warn("member sync failed", { error: (e as Error).message }));
    await introduceInChannel(ev.channel);
    return;
  }
  await ensureUser(ev.user);
  await setMembership(ev.channel, ev.user, true);
}

async function handleMemberLeft(ev: Record<string, any>): Promise<void> {
  if (!ev.channel || !ev.user) return;
  if (ev.user === (await botUserId())) await dropChannel(ev.channel);
  else await setMembership(ev.channel, ev.user, false);
}

/** Dispatch one Slack Events API `event_callback`. Dedupes by event_id, drops other workspaces, never throws. */
export async function handleEventCallback(body: EventCallback): Promise<void> {
  try {
    const ev = body.event;
    if (!ev?.type) return;
    if (body.event_id && !(await claimEvent(body.event_id))) return;
    const ws = await getWorkspace();
    if (!ws) { log.warn("slack event before install; dropped", { type: ev.type }); return; }
    if (body.team_id && body.team_id !== ws.id) { log.warn("slack event for foreign workspace dropped"); return; }

    switch (ev.type) {
      case "message":
      case "app_mention":
        log.info("slack message event received", { type: ev.type, workspaceMatched: true });
        await ingestHuddleAttachments(ev as SlackMessageEvent);
        return await handleMessage(ev as SlackMessageEvent);
      case "team_join":
        if (ev.user?.id) { await upsertSlackUser(ev.user); await onUserJoined(ev.user.id); }
        return;
      case "user_change":
        if (ev.user?.id) await upsertSlackUser(ev.user);
        return;
      case "member_joined_channel":
        return await handleMemberJoined(ev);
      case "member_left_channel":
      case "channel_left":
      case "group_left":
        if (ev.type === "member_left_channel") return await handleMemberLeft(ev);
        if (ev.channel) await dropChannel(ev.channel);
        return;
      case "channel_rename":
        if (ev.channel?.id) await upsertChannel({ id: ev.channel.id, name: ev.channel.name });
        return;
      case "channel_archive":
      case "channel_deleted":
        if (ev.channel) await dropChannel(typeof ev.channel === "string" ? ev.channel : ev.channel.id);
        return;
      case "reaction_added":
        return await handleReaction(ev);
      case "file_created":
      case "file_shared":
      case "file_change":
        // Only saved Huddle transcripts are ingested; every other Slack file is ignored.
        if (ev.file_id || ev.file?.id) {
          const fileId = String(ev.file_id ?? ev.file.id);
          try {
            const imported = await ingestHuddleFile(fileId, typeof ev.channel_id === "string" ? ev.channel_id : undefined);
            log.info("slack file event processed", { type: ev.type, fileId, imported });
          } catch (err) {
            log.warn("slack huddle file import failed", { type: ev.type, fileId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      case "assistant_thread_started":
        return await onAssistantThreadStarted(ev);
      case "app_uninstalled":
      case "tokens_revoked":
        // only the bot token matters: we store no user tokens
        if (ev.type === "tokens_revoked" && !ev.tokens?.bot?.length) return;
        return await handleWorkspaceGone(ev.type);
      case "app_home_opened":
        if (ev.tab !== "messages" && ev.user) await onAppHome(ev.user);
        return;
      default:
        return;
    }
  } catch (err) {
    log.error("slack event handler failed", { type: body.event?.type, error: (err as Error).message });
  }
}

