/**
 * Active-turn gate + inbox. While a turn is running in a thread, further messages from people in that thread
 * are not started as parallel turns: they wait in an inbox and run as ONE merged follow-up turn when the
 * current one ends. In-process only (ponytail: multi-process deployments still serialize via the turn queue,
 * they just don't merge).
 */
export type InboxMessage = { userId: string | null; ts: string; text: string; files?: { name: string; mimeType: string; text: string }[] };

type Slot = { inbox: InboxMessage[]; noticed: boolean };
const active = new Map<string, Slot>();

export const gateKey = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;
export const isActive = (key: string) => active.has(key);

/** Mark a turn active. Returns false when one already is (caller should `offer` instead). */
export function begin(key: string): boolean {
  if (active.has(key)) return false;
  active.set(key, { inbox: [], noticed: false });
  return true;
}

export const MAX_INBOX = 10;

/** Queue a message for the running turn. `notice` is true only for the first one (post a single heads-up). */
export function offer(key: string, m: InboxMessage): { queued: boolean; notice: boolean } {
  const s = active.get(key);
  if (!s) return { queued: false, notice: false };
  if (s.inbox.length >= MAX_INBOX) s.inbox.shift();
  s.inbox.push(m);
  const notice = !s.noticed;
  s.noticed = true;
  return { queued: true, notice };
}

/** Take everything queued so far (empties the inbox). */
export function drain(key: string): InboxMessage[] {
  const s = active.get(key);
  if (!s) return [];
  const out = s.inbox;
  s.inbox = [];
  s.noticed = false;
  return out;
}

export function end(key: string): void { active.delete(key); }

/** One turn's worth of text for several queued messages. */
export function mergeInbox(msgs: InboxMessage[]): { text: string; ts: string; userId: string | null; files: NonNullable<InboxMessage["files"]> } {
  const last = msgs[msgs.length - 1]!;
  const sameUser = msgs.every((m) => m.userId === last.userId);
  const text = msgs.length === 1 ? last.text : msgs.map((m) => `${sameUser ? "-" : `- <@${m.userId ?? "unknown"}>:`} ${m.text}`).join("\n");
  return { text: msgs.length === 1 ? text : `Several messages arrived while you were working; answer them together:\n${text}`, ts: last.ts, userId: last.userId, files: msgs.flatMap((m) => m.files ?? []) };
}

/** Test helper. */
export const resetGate = () => active.clear();
