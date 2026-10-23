import { generateText } from "ai";
import { getModel } from "../llm";
import { log } from "../log";
import type { Trigger } from "./prompt";

export type Depth = "direct" | "memory" | "tools" | "deep";
export type ToolFamily = "web" | "slack_search" | "automations" | "research";

/** Per-depth knobs: step cap, output cap, which model role answers. */
export const DEPTH_CONFIG: Record<Depth, { maxSteps: number; maxOutputTokens: number; role: "main" | "triage"; recall: boolean; tools: boolean }> = {
  direct: { maxSteps: 1, maxOutputTokens: 400, role: "triage", recall: false, tools: false },
  memory: { maxSteps: 3, maxOutputTokens: 800, role: "main", recall: true, tools: false },
  tools: { maxSteps: 20, maxOutputTokens: 2000, role: "main", recall: true, tools: true },
  deep: { maxSteps: 60, maxOutputTokens: 2000, role: "main", recall: true, tools: true },
};

const URL_RE = /https?:\/\/\S+/i;
const SMALL_TALK = /^(hi|hey|hello|yo|sup|thanks?|thank you|thx|ty|cheers|ok(ay)?|k|cool|nice|great|awesome|perfect|got it|gotcha|sounds good|lgtm|sgtm|will do|noted|appreciate it|good (morning|night|evening)|gm|gn|bye|cya|np|no worries|you rock|lol|haha|yes|yep|yeah|no|nope|nvm|never ?mind|[+👍🙏🙌✅❤️👌 ]+)([\s!.,)]*(thanks?|thx|ty|all|there|team|brain|again|so much|much))*[\s!.,:;)]*$/i;
const ACTION_RE = /\b(create|open|file|close|assign|reassign|schedule|remind|send|post|update|merge|deploy|rerun|re-run|review|comment|list|show me|pull up|find|check|look up|look at|what'?s (the )?(status|latest)|status of|how many|count|issues?|tickets?|prs?|pull requests?|repos?|sprint|deploys?|incidents?|alerts?|errors?|dashboard|linear|github|notion|jira|sentry|posthog|gmail|calendar|drive|doc|every (day|week|monday|tuesday|wednesday|thursday|friday)|cron|automation|search the web|google|news|slack|channel|thread)\b/i;
const DEEP_RE = /\b(research|investigate|investigation|analy[sz]e|analysis|deep[- ]dive|compare|comparison|audit|root cause|post-?mortem|write (a |the )?(report|summary|brief|spec|plan)|everything (we|you) (know|have)|comprehensive|end[- ]to[- ]end|step[- ]by[- ]step plan|across (all|every))\b/i;
const MEMORY_RE = /\b(who|what|when|where|why|how|which|did we|do we|have we|are we|is there|was there|remember|recall|decid|agreed|owner|owns|deadline|due|policy|last time|previously|history|background|context)\b/i;

export type DepthInput = {
  trigger: Trigger;
  text: string;
  hasFiles?: boolean;
  /** true when the thread already has earlier messages (follow-ups are ambiguous when short). */
  hasHistory?: boolean;
  readOnly?: boolean;
};

const strip = (t: string) => t.replace(/<@[A-Z0-9]+>/g, " ").replace(/<(https?:[^>|]+)(\|[^>]*)?>/g, "$1").replace(/\s+/g, " ").trim();

/** Pure heuristics. Returns null when genuinely ambiguous (caller may ask the cheap model). */
export function heuristicDepth(i: DepthInput): Depth | null {
  if (i.trigger === "research") return "deep";
  if (i.trigger === "automation") return DEEP_RE.test(i.text) ? "deep" : "tools";
  if (i.trigger === "chime") return ACTION_RE.test(i.text) && URL_RE.test(i.text) ? "tools" : "memory";
  const t = strip(i.text);
  if (!i.hasFiles && t.length <= 60 && SMALL_TALK.test(t)) return "direct";
  if (!t && !i.hasFiles) return "direct";
  const questions = (t.match(/\?/g) ?? []).length;
  if (t.length > 700 || questions >= 3 || DEEP_RE.test(t)) return "deep";
  if (URL_RE.test(t) || ACTION_RE.test(t) || i.hasFiles) return "tools";
  if (t.includes("?") || MEMORY_RE.test(t)) return "memory";
  // short follow-ups in a thread ("and the second one?" / "do that") depend on context: ambiguous
  return null;
}

export type DepthClassifier = (text: string, signal: AbortSignal) => Promise<string>;
const defaultClassifier: DepthClassifier = async (text, signal) =>
  (await generateText({
    model: getModel("triage"),
    system: "Classify the Slack message by how much work answering needs. Reply with one word: direct (greeting/thanks/chat, no lookup), memory (answerable from company memory), tools (needs live data from apps/web or an action), deep (multi-source research or long deliverable).",
    prompt: text.slice(0, 600),
    maxOutputTokens: 5,
    abortSignal: signal,
  })).text;

let classifier = defaultClassifier;
/** Test hook. */
export const setDepthClassifier = (f?: DepthClassifier) => { classifier = f ?? defaultClassifier; };

/** Heuristics first; cheap triage-role model only when ambiguous. Any failure falls back to "memory". */
export async function routeDepth(i: DepthInput): Promise<{ depth: Depth; by: "heuristic" | "model" | "fallback" }> {
  const h = heuristicDepth(i);
  if (h) return { depth: h, by: "heuristic" };
  try {
    const word = (await classifier(strip(i.text), AbortSignal.timeout(8_000))).trim().toLowerCase().match(/direct|memory|tools|deep/)?.[0] as Depth | undefined;
    if (word) return { depth: word, by: "model" };
  } catch (e) { log.warn("depth classifier failed", { error: String(e) }); }
  return { depth: "memory", by: "fallback" };
}

/** Rare tool families worth enabling up front when the request obviously needs them (others via enable_tool_family). */
export function likelyFamilies(text: string): ToolFamily[] {
  const out: ToolFamily[] = [];
  if (URL_RE.test(text) || /\b(web|google|news|public|online|website)\b/i.test(text)) out.push("web");
  if (/\b(slack|channel|thread|who (said|mentioned|asked)|conversation)\b/i.test(text)) out.push("slack_search");
  if (/\b(remind|schedule|every (day|week|month|monday|tuesday|wednesday|thursday|friday)|cron|automation|digest)\b/i.test(text)) out.push("automations");
  if (DEEP_RE.test(text)) out.push("research");
  return out;
}

/** Families a trigger may ever use (minimal read-only for unattended runs). */
export function allowedFamilies(trigger: Trigger, readOnly: boolean): ToolFamily[] {
  if (trigger === "chime") return [];
  if (trigger === "automation") return ["web", "slack_search"];
  if (trigger === "research") return ["web", "slack_search"];
  return readOnly ? ["web", "slack_search"] : ["web", "slack_search", "automations", "research"];
}
