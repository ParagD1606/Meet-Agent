import type { WebClient } from "@slack/web-api";
import { log } from "../log";
import { chunkText, toMrkdwn } from "./format";
import { clientMsgId, once } from "./idempotent";
import { sanitizeForSlack } from "./sanitize";

/** What a reply looks like once it is safe to post: broadcast pings stripped, markdown -> mrkdwn, split under Slack's limits. */
export const prepareReply = (text: string): string[] => chunkText(toMrkdwn(sanitizeForSlack(text)));

export type SinkOpts = {
  slack: WebClient;
  channel: string;
  threadTs?: string;
  teamId?: string;
  userId?: string | null;
  /** Try Slack native streaming (chat.startStream). Falls back to throttled chat.update on any failure. */
  native?: boolean;
  /** Assistant-pane thread: use assistant.threads.setStatus for progress instead of a placeholder message. */
  assistant?: boolean;
  /** Post a "Thinking" placeholder up front (update mode). */
  placeholder?: boolean;
  minGapMs?: number;
  /** Stable id of the triggering message. When set, final-reply posts are idempotent: a retried turn never posts the same reply twice. */
  idemKey?: string;
};

export type ReplySink = {
  begin(): Promise<void>;
  /** Text of the current model step so far (only worth calling for single-step turns). */
  text(textSoFar: string): void;
  status(s: string): void;
  /** Standalone mid-turn message (post_update). */
  narrate(text: string): Promise<boolean>;
  /** `actions`: Block Kit blocks (buttons) appended under the final message. */
  finish(text: string, o?: { actions?: unknown[] }): Promise<void>;
  fail(text: string): Promise<void>;
  readonly ts: string | undefined;
  readonly mode: "native" | "update";
};

const HOLDBACK = 64; // never stream the tail: a `<!channel>` token could still be mid-arrival

export function createReplySink(o: SinkOpts): ReplySink {
  const gap = o.minGapMs ?? 1200;
  let mode: "native" | "update" = o.native ? "native" : "update";
  let ts: string | undefined;
  let started = false; // native stream open
  let sentRaw = 0;
  let lastEdit = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (f: () => Promise<unknown>) => { chain = chain.then(f).catch((e) => log.warn("reply sink call failed", { error: String(e) })); return chain; };
  const thread = o.threadTs;

  const setAssistantStatus = (status: string) =>
    o.assistant && thread
      ? o.slack.assistant.threads.setStatus({ channel_id: o.channel, thread_ts: thread, status }).catch((e) => log.warn("setStatus failed", { error: String(e) }))
      : Promise.resolve();

  async function startNative(first: string) {
    const r = await o.slack.chat.startStream({
      channel: o.channel, thread_ts: thread!, markdown_text: first,
      ...(o.teamId ? { recipient_team_id: o.teamId } : {}), ...(o.userId ? { recipient_user_id: o.userId } : {}),
    } as never);
    ts = (r as { ts?: string }).ts;
    started = Boolean(ts);
    if (!started) throw new Error("startStream returned no ts");
  }
  const fallBack = (e: unknown) => { log.warn("native streaming failed; using chat.update", { error: String(e) }); mode = "update"; };

  return {
    get ts() { return ts; },
    get mode() { return mode; },
    async begin() {
      if (o.assistant) await setAssistantStatus("is thinking...");
      else if (mode === "update" && o.placeholder !== false) {
        const r = await o.slack.chat.postMessage({ channel: o.channel, thread_ts: thread, text: "_Thinking..._" });
        ts = (r as { ts?: string }).ts;
      }
    },
    text(t) {
      if (mode !== "native" || !thread) return;
      // sanitize only the settled part of the text
      const safeEnd = Math.max(0, t.length - HOLDBACK);
      let cut = safeEnd;
      const sp = t.lastIndexOf(" ", safeEnd);
      if (sp > sentRaw) cut = sp;
      if (cut <= sentRaw) return;
      const delta = sanitizeForSlack(t.slice(sentRaw, cut));
      const upto = cut;
      void serial(async () => {
        if (mode !== "native") return;
        try {
          if (!started) await startNative(delta);
          else await o.slack.chat.appendStream({ channel: o.channel, ts: ts!, markdown_text: delta });
          sentRaw = upto;
        } catch (e) { fallBack(e); }
      });
    },
    status(s) {
      if (o.assistant) { void setAssistantStatus(s); return; }
      if (mode !== "update" || !ts) return;
      const now = Date.now();
      if (now - lastEdit < gap) return;
      lastEdit = now;
      void serial(() => o.slack.chat.update({ channel: o.channel, ts: ts!, text: `_${s}_` }));
    },
    async narrate(text) {
      const [first] = prepareReply(text);
      if (!first) return false;
      try {
        await o.slack.chat.postMessage({ channel: o.channel, thread_ts: thread, text: first });
        return true;
      } catch (e) { log.warn("post_update failed", { error: String(e) }); return false; }
    },
    async finish(text, fo) {
      await chain;
      if (mode === "native" && started && ts) {
        try {
          const rest = sanitizeForSlack(text.slice(sentRaw));
          await o.slack.chat.stopStream({ channel: o.channel, ts, ...(rest ? { markdown_text: rest } : {}), ...(fo?.actions ? { blocks: fo.actions } : {}) } as never);
          return;
        } catch (e) { fallBack(e); await o.slack.chat.stopStream({ channel: o.channel, ts }).catch(() => undefined); }
      }
      if (o.assistant) await setAssistantStatus("");
      const [first, ...rest] = prepareReply(text);
      if (first === undefined) return;
      // buttons ride on the LAST chunk (section + actions; a section holds 3000 chars, so a longer chunk goes without)
      const lastIdx = rest.length;
      const withActions = (c: string, i: number) => (fo?.actions && i === lastIdx && c.length <= 3000 ? { blocks: [{ type: "section", text: { type: "mrkdwn", text: c } }, ...fo.actions] } : {});
      const keyOf = (i: number) => o.idemKey && `${o.channel}:${thread ?? ""}:${o.idemKey}:${i}`;
      // client_msg_id is sent too (Slack may ignore it); the claim in `events` is what guarantees at-most-once
      const post = async (c: string, i: number) => {
        const key = keyOf(i);
        const send = () => o.slack.chat.postMessage({ channel: o.channel, thread_ts: thread, text: c, ...withActions(c, i), ...(key ? { client_msg_id: clientMsgId(key) } : {}) } as never);
        return key ? once(key, send) : { replayed: false as const, value: await send() };
      };
      if (ts) {
        // a placeholder exists: a replayed first chunk means the real reply is already out, so drop the placeholder
        const edit = () => o.slack.chat.update({ channel: o.channel, ts: ts!, text: first, ...withActions(first, 0) } as never);
        const key = keyOf(0);
        const r = key ? await once(key, edit) : (await edit(), { replayed: false });
        if (r.replayed) { await o.slack.chat.delete({ channel: o.channel, ts }).catch(() => undefined); log.info("reply replay suppressed", { channel: o.channel }); }
      } else {
        const r = await post(first, 0);
        if (!r.replayed) ts = (r.value as { ts?: string }).ts;
      }
      for (const [i, c] of rest.entries()) await post(c, i + 1);
    },
    async fail(text) {
      await chain;
      if (o.assistant) await setAssistantStatus("");
      const [msg] = prepareReply(text);
      if (!msg) return;
      if (ts && !started) await o.slack.chat.update({ channel: o.channel, ts, text: msg }).catch(() => undefined);
      else await o.slack.chat.postMessage({ channel: o.channel, thread_ts: thread, text: msg }).catch(() => undefined);
    },
  };
}
