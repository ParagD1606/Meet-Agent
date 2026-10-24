import { getPersona, personaGreeting } from "../persona";
import { log } from "../log";
import { slackClient } from "./client";

export const SUGGESTED_PROMPTS = [
  { title: "What did we decide?", message: "What have we decided recently, and who owns the follow-ups?" },
  { title: "Catch me up", message: "Catch me up on what happened this week in the channels I am in." },
  { title: "Find a doc or thread", message: "Find the latest discussion about " },
  { title: "Set up a reminder", message: "Remind me every Monday at 9am to " },
] as const;

type AssistantThreadEvent = { assistant_thread?: { user_id?: string; channel_id?: string; thread_ts?: string } };

const known = new Map<string, { titled: boolean }>();
const tkey = (c: string, t: string) => `${c}:${t}`;
export const isAssistantThread = (channelId: string, threadTs?: string) => Boolean(threadTs && known.has(tkey(channelId, threadTs)));
export const resetAssistantThreads = () => known.clear();

/** `assistant_thread_started`: show suggested prompts in the new assistant pane thread. Never throws. */
export async function onAssistantThreadStarted(ev: AssistantThreadEvent): Promise<void> {
  const t = ev.assistant_thread;
  if (!t?.channel_id || !t.thread_ts) return;
  known.set(tkey(t.channel_id, t.thread_ts), { titled: false });
  if (known.size > 2000) known.delete(known.keys().next().value!);
  try {
    await (await slackClient()).assistant.threads.setSuggestedPrompts({
      channel_id: t.channel_id, thread_ts: t.thread_ts, title: personaGreeting(await getPersona()), prompts: SUGGESTED_PROMPTS.map((p) => ({ ...p })),
    });
  } catch (e) { log.warn("setSuggestedPrompts failed", { error: (e as Error).message }); }
}

/** Short thread title from the first message (no model call). */
export const titleFor = (text: string): string => {
  const t = text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 57).trimEnd()}...`;
};

export async function setThreadTitle(channelId: string, threadTs: string, text: string): Promise<void> {
  const title = titleFor(text);
  if (!title) return;
  try { await (await slackClient()).assistant.threads.setTitle({ channel_id: channelId, thread_ts: threadTs, title }); }
  catch (e) { log.warn("setTitle failed", { error: (e as Error).message }); }
}

/** First user message of an assistant thread names it (once). */
export async function noteAssistantMessage(channelId: string, threadTs: string | undefined, text: string): Promise<void> {
  const k = threadTs ? known.get(tkey(channelId, threadTs)) : undefined;
  if (!k || k.titled) return;
  k.titled = true;
  await setThreadTitle(channelId, threadTs!, text);
}
