import { generateText } from "ai";
import { cancel, offer, clearInbox, ownerOf, type InboxMessage } from "../slack/active-turn-gate";
import { getModel } from "../llm";
import { log } from "../log";

/** What a message that arrives while a turn is running should do to that turn. */
export type Steer = "IGNORE" | "APPEND" | "REPLACE" | "STOP";

const STOP_RE = /^\s*(?:<@\w+>\s*)?(?:please\s+)?(?:stop|cancel|abort|halt|never ?mind|nvm|forget it|stop (?:it|that|please)|cancel (?:it|that|this))[\s!.]*$/i;
const ACK_RE = /^\s*(?:thanks?|thank you|thx|ty|ok(?:ay)?|k|cool|nice|great|got it|noted|👍|🙏|✅)[\s!.]*$/i;

export type SteerClassifier = (active: string, incoming: string, signal: AbortSignal) => Promise<string>;
const defaultClassifier: SteerClassifier = async (active, incoming, signal) =>
  (await generateText({
    model: getModel("triage"),
    system: "A teammate's request is being worked on. They just sent another message in the same thread. Reply with ONE word: IGNORE (chit-chat/ack, needs no action), APPEND (extra detail or a separate follow-up to handle after the current work), or REPLACE (changes or supersedes the current request, so the current work should be abandoned).",
    prompt: `Current request: ${active.slice(0, 500)}\nNew message: ${incoming.slice(0, 500)}`,
    maxOutputTokens: 5,
    abortSignal: signal,
  })).text;

let classifier = defaultClassifier;
/** Test hook. */
export const setSteerClassifier = (f?: SteerClassifier) => { classifier = f ?? defaultClassifier; };

/** Stop words and acks are decided by regex; everything else by the cheap model. Any doubt or failure => APPEND (nothing lost, nothing aborted). */
export async function classifySteer(active: string, m: { text: string; hasFiles?: boolean }): Promise<Steer> {
  if (STOP_RE.test(m.text)) return "STOP";
  if (m.hasFiles) return "APPEND";
  if (ACK_RE.test(m.text)) return "IGNORE";
  try {
    const w = (await classifier(active, m.text, AbortSignal.timeout(5_000))).trim().toUpperCase().match(/IGNORE|APPEND|REPLACE/)?.[0];
    if (w) return w as Steer;
  } catch (e) { log.warn("steer classifier failed", { error: String(e) }); }
  return "APPEND";
}

/**
 * A message arrived in a thread whose turn is still running (the gate holds the per-thread slot; the turn queue's advisory
 * lock still serializes the actual runs). STOP and REPLACE are honoured only from the person who started the running turn,
 * anyone else's message is just queued. Returns what happened so the caller can post the one-time "queued" notice.
 */
export async function steerActive(key: string, m: InboxMessage): Promise<{ action: Steer; notice: boolean; handled: boolean }> {
  const owner = ownerOf(key);
  if (!owner) return { action: "APPEND", notice: false, handled: false }; // turn ended meanwhile: caller starts it normally
  const mine = owner.userId !== null && owner.userId === m.userId;
  let action = await classifySteer(owner.text, { text: m.text, hasFiles: !!m.files?.length });
  if ((action === "STOP" || action === "REPLACE") && !mine) action = "APPEND";
  if (action === "IGNORE") return { action, notice: false, handled: true };
  if (action === "STOP") { clearInbox(key); cancel(key, "stop"); return { action, notice: false, handled: true }; }
  if (action === "REPLACE") { clearInbox(key); cancel(key, "replace"); }
  const q = offer(key, m); // not queued when the turn finished while we classified: caller starts it normally
  return { action, notice: q.notice && action === "APPEND", handled: q.queued };
}
