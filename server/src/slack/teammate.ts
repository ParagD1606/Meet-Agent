import { and, eq, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, settings, users } from "../db/schema";
import { checkRate } from "../limits/rate";
import { log } from "../log";
import { scanMemoryText } from "../memory/core-blocks";
import { addFact } from "../memory/facts";
import { writeTag } from "../memory/scope";
import { askConfirmCard, button, section } from "./cards";
import { openDm, postMessage, slackClient } from "./client";
import { sanitizeForSlack } from "./sanitize";

/**
 * Ask-a-teammate state lives in `settings` rows keyed `ask:<id>` (no migration). Lifecycle:
 * proposed (card shown) -> confirmed (asker said yes) -> sent (delivered, waiting) -> answered | cancelled | failed.
 * ponytail: scanned by key prefix; add a table if pending asks ever number in the thousands.
 */
export type Ask = {
  id: string; status: "proposed" | "confirmed" | "sent" | "answered" | "cancelled" | "failed";
  asker: string; owner: string; question: string;
  origin: { channelId: string; threadTs?: string; isPrivate: boolean; isIm: boolean };
  target?: { channelId: string; threadTs?: string };
  /** ISO time the ask was proposed; an unanswered ask stops capturing replies after ASK_TTL_MS. */
  createdAt?: string;
};
export const ASK_TTL_MS = 24 * 3_600_000;

/** Test seam: how a deferred delivery is scheduled (pg-boss in production). */
export const askDeps = {
  now: () => new Date(),
  defer: async (id: string, at: Date): Promise<void> => { await (await import("../jobs")).enqueueAskDelivery(id, at); },
};

const key = (id: string) => `ask:${id}`;
export async function getAsk(id: string): Promise<Ask | null> {
  const [r] = await db.select().from(settings).where(eq(settings.key, key(id)));
  return (r?.value as Ask | undefined) ?? null;
}
const saveAsk = (a: Ask) => db.insert(settings).values({ key: key(a.id), value: a }).onConflictDoUpdate({ target: settings.key, set: { value: a } });
/** Atomic status transition; false when someone else already moved it. */
async function advance(id: string, from: Ask["status"], to: Ask["status"], patch: Partial<Ask> = {}): Promise<boolean> {
  const r = await db.execute(sql`update settings set value = value || ${JSON.stringify({ ...patch, status: to })}::jsonb where key = ${key(id)} and value->>'status' = ${from} returning key`);
  return r.rows.length > 0;
}

// ---- quiet hours: weekdays 09:00-18:00 in ASK_TIMEZONE (default UTC); outside that, delivery waits for the next window ----
const TZ = () => process.env.ASK_TIMEZONE || "UTC";
function localParts(d: Date): { wd: string; h: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ(), weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday!, h: Number(p.hour) };
}
const inWindow = (d: Date) => { const { wd, h } = localParts(d); return wd !== "Sat" && wd !== "Sun" && h >= 9 && h < 18; };
/** null when `now` is inside the window, else the start of the next one (hourly scan: windows start on the hour in whole-hour zones). */
export function nextWindow(now: Date): Date | null {
  if (process.env.QUIET_HOURS !== "1" || inWindow(now)) return null; // quiet hours are off unless QUIET_HOURS=1
  let t = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  for (let i = 0; i < 24 * 8 && !inWindow(t); i++) t = new Date(t.getTime() + 3_600_000);
  return t;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

/** Posts the consent card to the asker's thread. Nothing reaches the owner until the asker clicks. */
export async function proposeAsk(a: { asker: string; owner: string; question: string; origin: Ask["origin"] }): Promise<string> {
  const ask: Ask = { id: newId("ask_"), status: "proposed", asker: a.asker, owner: a.owner, question: clean(a.question), origin: a.origin, createdAt: askDeps.now().toISOString() };
  await saveAsk(ask);
  const card = askConfirmCard({ id: ask.id, owner: ask.owner, question: ask.question });
  await postMessage({ channel: a.origin.channelId, thread_ts: a.origin.threadTs, text: card.text, blocks: card.blocks });
  return ask.id;
}

const say = (a: Ask, text: string) => postMessage({ channel: a.origin.channelId, thread_ts: a.origin.threadTs, text }).catch((e: Error) => log.warn("ask notice failed", { error: e.message }));

/** Deliver now, or defer to the next window. Charges the target's daily bucket only when it actually sends. */
export async function attemptDelivery(id: string, o: { now?: Date; notify?: boolean } = {}): Promise<"sent" | "deferred" | "limited" | "skipped"> {
  const ask = await getAsk(id);
  if (!ask || ask.status !== "confirmed") return "skipped";
  const now = o.now ?? askDeps.now();
  const at = nextWindow(now);
  if (at) {
    await askDeps.defer(id, at);
    if (o.notify) await say(ask, `It's outside working hours for <@${ask.owner}>, so I'll ask them at ${at.toISOString().slice(0, 16).replace("T", " ")} UTC.`);
    return "deferred";
  }
  const rate = await checkRate({ userId: ask.owner, channelId: ask.origin.channelId, kind: "ask" }, now.getTime());
  if (!rate.ok) {
    await advance(id, "confirmed", "failed");
    await say(ask, `I've already pinged <@${ask.owner}> a few times today, so I'll hold off. You could message them directly.`);
    return "limited";
  }
  if (!(await advance(id, "confirmed", "sent"))) return "skipped";
  const member = !ask.origin.isIm && ask.origin.threadTs
    ? (await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, ask.origin.channelId), eq(channelMembers.userId, ask.owner)))).length > 0
    : false;
  const q = sanitizeForSlack(ask.question);
  try {
    if (member) {
      await postMessage({ channel: ask.origin.channelId, thread_ts: ask.origin.threadTs, text: `<@${ask.owner}> <@${ask.asker}> is asking: "${q}". Reply here and I'll pass your answer on and save it to memory.` });
      await advance(id, "sent", "sent", { target: { channelId: ask.origin.channelId, threadTs: ask.origin.threadTs } });
    } else {
      // DM: only the question text; no channel, thread or source detail
      const dm = await openDm(ask.owner);
      if (!dm) throw new Error("could not open DM");
      const r = await postMessage({ channel: dm, text: `Hi, <@${ask.asker}> asked me to check with you: "${q}". Reply here and I'll pass your answer on and save it to memory. Only the question was shared.` });
      await advance(id, "sent", "sent", { target: { channelId: dm, threadTs: (r as { ts?: string }).ts } });
      await say(ask, `I asked <@${ask.owner}> directly. I'll bring their answer back here.`);
    }
    return "sent";
  } catch (e) {
    await advance(id, "sent", "failed");
    await say(ask, `I couldn't reach <@${ask.owner}>. You may want to message them directly.`);
    log.warn("ask delivery failed", { id, error: String(e) });
    return "skipped";
  }
}

type Payload = { user?: { id?: string }; channel?: { id?: string }; container?: { channel_id?: string; message_ts?: string }; message?: { ts?: string } };

/** `brain_ask_yes` / `brain_ask_no`: only the asker's click counts. */
export async function handleAskAction(payload: Payload, a: { action_id?: string; value?: string }): Promise<boolean> {
  if (a.action_id === "brain_ask_pick") return handlePick(payload, a.value);
  if (a.action_id !== "brain_ask_yes" && a.action_id !== "brain_ask_no") return false;
  const ask = a.value ? await getAsk(a.value) : null;
  if (!ask || ask.status !== "proposed" || payload.user?.id !== ask.asker) return true;
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  const yes = a.action_id === "brain_ask_yes";
  if (!(await advance(ask.id, "proposed", yes ? "confirmed" : "cancelled"))) return true;
  if (channel && ts) await (await slackClient()).chat.update({ channel, ts, text: yes ? `Asking <@${ask.owner}>...` : "No problem, I won't ask.", blocks: [] }).catch(() => undefined);
  if (yes) await attemptDelivery(ask.id, { notify: true });
  return true;
}

/** Closes asks nobody answered within the TTL (legacy rows without createdAt included). Returns how many changed. */
export async function expireStaleAsks(now = askDeps.now()): Promise<number> {
  const r = await db.execute(sql`update settings set value = value || '{"status":"failed"}'::jsonb
    where key like 'ask:%' and value->>'status' in ('proposed','confirmed','sent')
      and (value->>'createdAt' is null or (value->>'createdAt')::timestamptz < ${new Date(now.getTime() - ASK_TTL_MS).toISOString()}::timestamptz) returning key`);
  return r.rows.length;
}

type Msg = { user?: string; text?: string; channel: string; thread_ts?: string };

const fresh = (a: Ask) => !!a.createdAt && askDeps.now().getTime() - Date.parse(a.createdAt) < ASK_TTL_MS;

/** Asks delivered to `owner` that are still waiting (sent, under 24h old). */
export async function openAsksFor(owner: string): Promise<Ask[]> {
  const rows = await db.select().from(settings).where(sql`${settings.key} like 'ask:%' and ${settings.value}->>'status' = 'sent' and ${settings.value}->>'owner' = ${owner}`);
  return rows.map((r) => r.value as Ask).filter((a) => a.target && fresh(a));
}

/** Marks the ask answered, stores the Q/A (created_by = owner) in the asker's write scope and relays the owner's words to the asker. */
async function answerAsk(ask: Ask, owner: string, text: string): Promise<void> {
  if (!(await advance(ask.id, "sent", "answered"))) return;
  const answer = clean(text).slice(0, 700);
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, owner));
  const who = row?.name ?? "a teammate";
  const tag = writeTag({ channelId: ask.origin.channelId, isPrivate: ask.origin.isPrivate, isIm: ask.origin.isIm, userId: ask.asker });
  const fact = `Q: ${ask.question} A: ${answer} (answered by ${who})`;
  if (tag && !scanMemoryText(fact)) {
    await addFact({ tag, text: fact, source: "slack", sourceRef: `${ask.origin.channelId}:${ask.origin.threadTs ?? ""}`, createdBy: owner, factType: "fact", confidence: 0.8, agentContext: "primary" })
      .catch((e) => log.warn("owner reply save failed", { error: String(e) }));
  }
  const same = ask.target!.channelId === ask.origin.channelId;
  await postMessage({
    channel: ask.origin.channelId, thread_ts: ask.origin.threadTs,
    text: same ? `Thanks <@${owner}>. <@${ask.asker}>, that's your answer, and I saved it for next time.` : `<@${ask.asker}> ${who} replied: "${sanitizeForSlack(answer)}". I saved it for next time.`,
  }).catch((e: Error) => log.warn("ask relay failed", { error: e.message }));
}

const thank = async (ask: Ask, channel: string, thread_ts?: string) => {
  const [a] = await db.select({ name: users.name }).from(users).where(eq(users.id, ask.asker));
  await postMessage({ channel, thread_ts, text: `Thanks, I passed that on to ${a?.name ?? `<@${ask.asker}>`}.` }).catch((e: Error) => log.warn("ask thanks failed", { error: e.message }));
};

/** `brain_ask_pick`: the owner chose which open question their DM answered. Only the owner's click counts. */
async function handlePick(payload: Payload, value?: string): Promise<boolean> {
  let v: { a?: string; t?: string } = {};
  try { v = JSON.parse(value ?? "{}"); } catch { return true; }
  const ask = v.a ? await getAsk(v.a) : null;
  if (!ask || !v.t || ask.status !== "sent" || payload.user?.id !== ask.owner || !fresh(ask)) return true;
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  await answerAsk(ask, ask.owner, v.t);
  if (channel && ts) await (await slackClient()).chat.update({ channel, ts, text: "Got it.", blocks: [] }).catch(() => undefined);
  if (channel) await thank(ask, channel);
  return true;
}

/**
 * Called for every human Slack message. If it is the owner answering a sent ask, store the answer (source tagged to the
 * owner) in the asker's write scope and relay it. Matches: a reply in the asked thread; or a top-level DM when exactly
 * one ask to this owner is open (two or more: the owner picks with buttons). Returns true when consumed.
 */
export async function captureOwnerReply(m: Msg): Promise<boolean> {
  if (!m.user || !m.text?.trim()) return false;
  const open = await openAsksFor(m.user);
  const inThread = open.find((a) => a.target!.channelId === m.channel && m.thread_ts === a.target!.threadTs);
  const dms = m.thread_ts || /\?\s*$/.test(m.text) ? [] : // a question back ("lunch at 1?") is not an answer
     open.filter((a) => a.target!.channelId === m.channel && a.target!.channelId !== a.origin.channelId);
  const ask = inThread ?? (dms.length === 1 ? dms[0] : undefined);
  if (ask) {
    await answerAsk(ask, m.user, m.text);
    if (ask.target!.channelId !== ask.origin.channelId) await thank(ask, m.channel, m.thread_ts);
    return true;
  }
  if (dms.length < 2) return false;
  const t = clean(m.text).slice(0, 700);
  const text = "Thanks. Which question is that answering?";
  await postMessage({ channel: m.channel, text, blocks: [section(text), { type: "actions", elements: dms.slice(0, 5).map((a) => button(a.question.slice(0, 70), "brain_ask_pick", { value: JSON.stringify({ a: a.id, t }) })) }] });
  return true;
}
