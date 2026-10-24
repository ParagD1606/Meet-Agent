import { generateText } from "ai";
import { getModel } from "../llm";
import { log } from "../log";
import type { Trigger } from "./prompt";

export type Depth = "direct" | "memory" | "tools" | "deep";
export type ToolFamily = "web" | "slack_search" | "automations" | "research";

/** Per-depth knobs: step cap, output cap, which model role answers. */
export const DEPTH_CONFIG: Record<Depth, { maxSteps: number; maxOutputTokens: number; role: "main" | "triage"; recall: boolean; tools: boolean; /** read-only memory_search without the full tool set */ memorySearch?: boolean }> = {
  direct: { maxSteps: 1, maxOutputTokens: 400, role: "triage", recall: false, tools: false },
  memory: { maxSteps: 5, maxOutputTokens: 800, role: "main", recall: true, tools: false, memorySearch: true },
  tools: { maxSteps: 20, maxOutputTokens: 2000, role: "main", recall: true, tools: true },
  deep: { maxSteps: 60, maxOutputTokens: 2000, role: "main", recall: true, tools: true },
};

const CONTINUE = /^(continue|keep going|go on|carry on|resume)\b/i;
const URL_RE = /https?:\/\/\S+/i;
const SMALL_TALK = /^(hi|hey|hello|yo|sup|thanks?|thank you|thx|ty|cheers|ok(ay)?|k|cool|nice|great|awesome|perfect|got it|gotcha|sounds good|lgtm|sgtm|will do|noted|appreciate it|good (morning|night|evening)|gm|gn|bye|cya|np|no worries|you rock|lol|haha|yes|yep|yeah|no|nope|nvm|never ?mind|[+👍🙏🙌✅❤️👌 ]+)([\s!.,)]*(thanks?|thx|ty|all|there|team|brain|again|so much|much))*[\s!.,:;)]*$/i;
const ACTION_RE = /\b(create|open|file|close|assign|reassign|schedule|remind|send|post|update|merge|deploy|rerun|re-run|review|comment|list|show me|pull up|find|check|look up|look at|what'?s (the )?(status|latest)|status of|how many|count|issues?|tickets?|prs?|pull requests?|repos?|sprint|deploys?|incidents?|alerts?|errors?|dashboard|linear|github|notion|jira|sentry|posthog|gmail|calendar|drive|doc|every (day|week|monday|tuesday|wednesday|thursday|friday)|cron|automation|search the web|google|news|slack|channel|thread)\b/i;
const DEEP_RE = /\b(research|investigate|investigation|analy[sz]e|analysis|deep[- ]dive|compare|comparison|audit|root cause|post-?mortem|write (a |the )?(report|summary|brief|spec|plan)|everything (we|you) (know|have)|comprehensive|end[- ]to[- ]end|step[- ]by[- ]step plan|across (all|every))\b/i;
const MEMORY_RE = /\b(who|what|when|where|why|how|which|did we|do we|have we|are we|is there|was there|remember|recall|decid|agreed|owner|owns|deadline|due|policy|last time|previously|history|background|context)\b/i;
/** "who was given X", "who owns Y", "what's due", "my open tasks": answered from tracked tasks (find_tasks), no live app tools needed. */
const TASK_Q_RE = /\b(who('s| is| was| were| has| had| got| gets)?( been)? (given|assigned|responsible|handling|taking|working on|supposed|tasked|on)|who (owns|owned|took|takes|will|should|is doing|was doing)|assigned to|(task|work|ticket)s? (was|were|is|are) (given|assigned)|who'?s (the )?(owner|assignee)|(what|which) (tasks?|items?) .{0,30}(due|overdue|open|assigned)|what'?s (due|overdue|open)|(my|our|his|her|their) (open |pending )?(tasks|to-?dos|action items)|due (this|next|today|tomorrow))\b/i;
const SAVE_MEMORY_RE = /\b(please )?(remember|save|store) (this|that|it)\b/i;
const COMPANY_PROFILE_RE = /\b(our company|our startup|our product|company profile|this is what (our|the) company is all about)\b/i;
const QUESTION_START = /^(what|who|when|where|why|how|which|is|are|does|do|did|can|could)\b/i; // a question about the company is a read, not a profile to save
const CORRECTION_RE = /^(actually|correction)\b|\bthat'?s (wrong|incorrect|not (right|correct))\b/i;

/** An imperative about another person or an action: needs tools (a model with none can only pretend). */
const DO_RE = /\b(tell(?! me\b)|inform|notify|message|dm|ping|ask|remind|assign|reassign|say (hi|hello|hey)|let \S+ know|follow[- ]?up|done|completed?|schedule|send|forward|create|make|add)\b/i;
const STATUS_Q = /^(is|are|was|were|has|have|did|does)\b[^?]*\b(done|completed?)\b[^?]*\?$/i;
/** A short reply that continues an action thread ("ok", "yes", "do it", "tell him ..."). */
const REPLY_RE = /^(ok(ay)?|yes|yep|yeah|sure|please( do)?|do it|go ahead|yes please|tell (him|her|them)\b.*|continue|keep going|go on)[\s!.,]*$|^(ok(ay)?|yes|sure)[,. ]+\S/i;
const MENTION_RE = /<@[A-Z0-9]+>/g;

export type DepthInput = {
  trigger: Trigger;
  text: string;
  hasFiles?: boolean;
  /** true when the thread already has earlier messages (follow-ups are ambiguous when short). */
  hasHistory?: boolean;
  readOnly?: boolean;
  /** Previous bot turn in this thread/DM: replies like "ok" or "continue" inherit its depth (floor tools) when it acted or an ask is open. */
  prev?: { depth: Depth; usedTools: boolean; openAsk: boolean };
};

const strip = (t: string) => t.replace(/<@[A-Z0-9]+>/g, " ").replace(/<(https?:[^>|]+)(\|[^>]*)?>/g, "$1").replace(/\s+/g, " ").trim();

/** Pure heuristics. Returns null when genuinely ambiguous (caller may ask the cheap model). */
export function heuristicDepth(i: DepthInput): Depth | null {
  if (i.trigger === "research") return "deep";
  if (i.trigger === "automation") return DEEP_RE.test(i.text) ? "deep" : "tools";
  if (i.trigger === "chime") return ACTION_RE.test(i.text) && URL_RE.test(i.text) ? "tools" : "memory";
  const t = strip(i.text);
  const p = i.prev;
  if (p && CONTINUE.test(t)) return p.depth === "direct" || p.depth === "memory" ? "tools" : p.depth;
  if (p && (p.usedTools || p.openAsk) && t.length <= 80 && REPLY_RE.test(t)) return p.depth === "deep" ? "deep" : "tools";
  if (i.hasHistory && CONTINUE.test(t)) return "deep";
  const others = (i.text.match(MENTION_RE)?.length ?? 0) - (i.trigger === "mention" ? 1 : 0);
  // "is the X feature done?" asks about a task's status (a read); only "done"/"completed" as a statement or order is an action
  const doText = STATUS_Q.test(t) ? t.replace(/\b(done|completed?)\b/gi, "") : t;
  if (!i.hasFiles && (DO_RE.test(doText) || others > 0) && !DEEP_RE.test(t) && t.length <= 700 && (t.match(/\?/g) ?? []).length < 3) return "tools";
  if (!i.hasFiles && t.length <= 60 && SMALL_TALK.test(t)) return "direct";
  if (!t && !i.hasFiles) return "direct";
  const questions = (t.match(/\?/g) ?? []).length;
  // saving/correcting needs memory_remember / core_memory, which only exist at depth tools
  if ((SAVE_MEMORY_RE.test(t) || (COMPANY_PROFILE_RE.test(t) && !QUESTION_START.test(t)) || (i.hasHistory && !t.includes("?") && CORRECTION_RE.test(t))) && !DEEP_RE.test(t) && !ACTION_RE.test(t) && !URL_RE.test(t)) return "tools";
  if (t.length > 700 || questions >= 3 || DEEP_RE.test(t)) return "deep";
  if (TASK_Q_RE.test(t) && !URL_RE.test(t) && !i.hasFiles && !/\b(create|file|open|close|reassign|schedule|remind|update|send|post)\b/i.test(t)) return "memory";
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
    // only pure greetings/thanks may be "direct" (those are caught by the heuristics above)
    if (word) return { depth: word === "direct" ? "memory" : word, by: "model" };
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
