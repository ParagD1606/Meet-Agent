// Deterministic post-processing of a drafted reply (no model call, a few ms): citation allowlist, tautology guard, write receipts.
// Flow: draft -> tautology guard -> strip unsourced links -> append write receipts -> post.
import { contentStems, stem } from "../memory/signal";

// ---- write receipts -----------------------------------------------------------------------------------------------
/** Write tools end their result with `[receipt] <key> | <display>`; the loop turns it into the visible receipt line. `key` may list alternatives with "/". */
export const RECEIPT_TAG = "[receipt] ";
export const withReceipt = (msg: string, key: string, display: string) => `${msg}\n${RECEIPT_TAG}${key} | ${display}`;

export type ToolOutput = { name: string; text: string; error?: boolean };
export type Receipt = { keys: string[]; display: string; tool: string };

const INTERNAL_WRITE = /^(assign_task|update_task|notify_teammate|memory_remember|schedule_follow_up|ask_teammate|core_memory|forget_memories|request_connection|request_teammate_access|post_update|enable_tool_family|search_tools)$/;
const MCP_WRITE = /(create|update|delete|send|post|comment|merge|close|open|add|assign|transition|move|write)/i;

/** Receipts of the successful write tools of this turn: ours (tagged) and generic ones for MCP writes (first URL or id in the result). */
export function receiptsOf(outputs: ToolOutput[]): Receipt[] {
  const out: Receipt[] = [];
  for (const o of outputs) {
    if (o.error || /^ERROR:/.test(o.text)) continue;
    const m = new RegExp(`^${RECEIPT_TAG.replace(/[[\]]/g, "\\$&")}(.+)$`, "m").exec(o.text);
    if (m) {
      const [key, ...rest] = m[1]!.split(" | ");
      out.push({ keys: key!.split("/").map((k) => k.trim()).filter(Boolean), display: rest.join(" | ").trim(), tool: o.name });
      continue;
    }
    if (INTERNAL_WRITE.test(o.name) || !MCP_WRITE.test(o.name)) continue;
    const url = urlsIn(o.text)[0];
    const id = /"(?:id|key|number|identifier)"\s*:\s*"?([\w-]{2,40})/.exec(o.text)?.[1];
    if (url || id) out.push({ keys: [url ?? id!], display: `${o.name.replace(/_+/g, " ")} done${id ? ` (id ${id})` : ""}${url ? `, ${url}` : ""}`, tool: o.name });
  }
  return out;
}

/** Appends `— receipt: ...` for each successful write unless the reply already carries its key facts (id / person / link). */
export function appendReceipts(text: string, outputs: ToolOutput[]): { text: string; added: number } {
  const lower = text.toLowerCase();
  const missing = receiptsOf(outputs).filter((r) => !r.keys.some((k) => lower.includes(k.toLowerCase())));
  const seen = new Set<string>();
  const lines = missing.filter((r) => !seen.has(r.display) && seen.add(r.display)).map((r) => `— receipt: ${r.display}`);
  return lines.length ? { text: `${text.trimEnd()}\n\n${lines.join("\n")}`, added: lines.length } : { text, added: 0 };
}

// ---- claim target matching ----------------------------------------------------------------------------------------
const PERSON = String.raw`(<@[UW][A-Z0-9]+>|\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'-]+)?)`;
const VERBS = String.raw`(?:told|informed|notified|messaged|pinged|asked|assigned|reminded|dm'?ed|looped in|let|sent(?: it)? to|passed (?:it|that) on to|assigned(?: (?:this|it|that|the task))? to)`;
const NOT_NAMES = new Set(["I", "Done", "Sent", "Sure", "Ok", "Okay", "Yes", "No", "Task", "Slack", "It", "That", "This", "Him", "Her", "Them", "The", "You", "We", "They", "Everyone", "Team"]);
/** Who a reply says it told / notified / assigned: "I've told Dana", "Dana has been notified", "assigned to <@U1>". */
export function claimTargets(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => { if (s && !NOT_NAMES.has(s.split(" ")[0]!)) out.add(s); };
  for (const m of text.matchAll(new RegExp(`\\b${VERBS}\\s+${PERSON}`, "giu"))) add(m[1]);
  for (const m of text.matchAll(new RegExp(`${PERSON}\\s+(?:has|have)\\s+(?:now |just |already )?been\\s+(?:told|informed|notified|messaged|pinged|reminded)\\b`, "gu"))) add(m[1]);
  return [...out];
}
/** Does a successful write result of this turn mention this person (id, mention, or first/full name)? */
export function targetBacked(target: string, outputs: ToolOutput[]): boolean {
  const id = /<@([UW][A-Z0-9]+)>/.exec(target)?.[1];
  const name = id ? null : target.toLowerCase();
  return outputs.some((o) => {
    if (o.error || /^ERROR:/.test(o.text)) return false;
    const t = o.text.toLowerCase();
    return id ? t.includes(id.toLowerCase()) : t.includes(name!) || t.includes(name!.split(" ")[0]!);
  });
}

// ---- citations ----------------------------------------------------------------------------------------------------
const BARE = /https?:\/\/[^\s<>|)\]"'`]+/gi;
const SLACK_LINK = /<(https?:\/\/[^\s|>]+)(?:\|([^>]*))?>/gi;
const MD_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g;
/** Comparison form: no trailing punctuation, fragment or slash; scheme and host lowercase. */
export function normUrl(u: string): string {
  const t = u.replace(/[.,;:!?)\]}>*_]+$/, "").replace(/#.*$/, "").replace(/\/+$/, "");
  const m = /^(https?:\/\/)([^/?]+)(.*)$/i.exec(t);
  return m ? `${m[1]!.toLowerCase()}${m[2]!.toLowerCase()}${m[3]}` : t;
}
export const urlsIn = (text: string): string[] => [...text.matchAll(SLACK_LINK)].map((m) => m[1]!).concat(text.match(BARE) ?? []);
/** Allowlist = every URL in the context the model was given (recalled hits and permalinks, asker text, thread, tool results). */
export function allowlist(parts: string[]): Set<string> {
  const s = new Set<string>();
  for (const p of parts) for (const u of urlsIn(p)) s.add(normUrl(u));
  return s;
}

/** Removes http(s) links that are not allowlisted, keeping their label text. Handles <url|label>, <url>, [label](url) and bare URLs. */
export function stripUnsourcedLinks(text: string, allow: Set<string>): { text: string; stripped: number } {
  let stripped = 0;
  const ok = (u: string) => allow.has(normUrl(u));
  let t = text.replace(SLACK_LINK, (m, url: string, label?: string) => (ok(url) ? m : (stripped++, label?.trim() ?? "")));
  t = t.replace(MD_LINK, (m, label: string, url: string) => (ok(url) ? m : (stripped++, label)));
  t = t.replace(BARE, (m) => (ok(m) ? m : (stripped++, /[.,;:!?]+$/.exec(m)?.[0] ?? ""))); // keep the sentence's own punctuation
  if (!stripped) return { text, stripped };
  t = t.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/(?:\s*·\s*){2,}/g, " · ").replace(/\s*·\s*$/gm, "").replace(/\s+([.,;:!?])/g, "$1");
  t = t.replace(/^[ \t]*(?:\*?Sources?:?\*?|Source:)[ \t]*$\n?/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: t, stripped };
}

// ---- tautology ----------------------------------------------------------------------------------------------------
const FILLER = new Set("located situated based found called named known present available exists exist currently right now still just also actually".split(" ").map(stem));
const NEGATED = /\b(don'?t|do not|doesn'?t|didn'?t|no record|not sure|can'?t|cannot|unable|couldn'?t|nothing|isn'?t|aren'?t|haven'?t|hasn'?t|unknown|not in|no idea|never)\b/i;
export const ABSTAIN_REPLY = "I don't have a record that answers that, and I'd rather not guess. I checked what the team has shared with me and found nothing on it. Want me to ask someone who would know, or look in a connected tool?";

const claimSentences = (answer: string) => answer
  .replace(SLACK_LINK, (_m, _u, l?: string) => l ?? "").replace(MD_LINK, "$1").replace(BARE, "")
  .split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !s.endsWith("?") && !/^\*?sources?:?/i.test(s) && !NEGATED.test(s));

/**
 * True when the reply only restates the question ("Which city is our Berlin office in?" -> "Our Berlin office is located in Berlin.")
 * with nothing in `support` (recalled hits, tool results, the thread) that backs it: every claim sentence shares > 80% of its
 * content words with the question and no support text contains all of them.
 */
export function isTautology(question: string, answer: string, support: string[]): boolean {
  const q = contentStems(question);
  const claims = claimSentences(answer).map((s) => [...contentStems(s)].filter((w) => !FILLER.has(w))).filter((w) => w.length > 0);
  if (!claims.length) return false;
  const sup = support.map(contentStems);
  return claims.every((words) => words.filter((w) => q.has(w)).length / words.length > 0.8 && !sup.some((s) => words.every((w) => s.has(w))));
}

// ---- orchestration ------------------------------------------------------------------------------------------------
export type VerifyInput = {
  text: string;
  question: string;
  /** a factual question about company knowledge (tautology guard applies only then) */
  factual: boolean;
  /** texts that can back a claim: recalled hits, tool results, the asker's own thread messages */
  support: string[];
  /** texts whose URLs the model was allowed to see */
  urlSources: string[];
  /** a write tool ran: the receipt logic, not the tautology guard, owns this reply */
  acted: boolean;
  tautology: boolean;
  citations: boolean;
};
export type VerifyResult = { text: string; strippedLinks: number; tautologyBlocked: boolean };

/** Never throws: on any error the draft is returned untouched. */
export function verifyAnswer(i: VerifyInput): VerifyResult {
  try {
    let text = i.text;
    let tautologyBlocked = false;
    if (i.tautology && i.factual && !i.acted && isTautology(i.question, text, i.support)) { text = ABSTAIN_REPLY; tautologyBlocked = true; }
    const r = i.citations ? stripUnsourcedLinks(text, allowlist(i.urlSources)) : { text, stripped: 0 };
    return { text: r.text, strippedLinks: r.stripped, tautologyBlocked };
  } catch {
    return { text: i.text, strippedLinks: 0, tautologyBlocked: false };
  }
}
