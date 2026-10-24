import { createHash } from "node:crypto";

/**
 * The stored shape of everything a meeting produced (meetings.tasks JSON): tasks, decisions and open questions are all "items".
 * Pure helpers only (no database), so the classification rules are unit-testable.
 */
export type ItemType = "task" | "decision" | "question";
export type Kind = "commitment" | "suggestion" | "question";
export type Label = "confirmed" | "tentative" | "suggestion" | "question";
export type Approval = "proposed" | "approved" | "rejected";
export type Candidate = { id: string; name: string; score: number };
export type DupRef = { source: "task" | "meeting"; id: string; meetingId?: string; title: string; ownerName: string | null; dueDate: string | null };
export type Conflict = { type: "owner" | "due" | "decision"; /** the date / owner was said and then changed within the same meeting (with = the earlier value) */ restated?: boolean; with: { id: string; title: string; ownerName: string | null; dueDate: string | null } };
export type Ambiguity = {
  ownerMissing: boolean; ownerAmbiguous: boolean; ownerCandidates: Candidate[]; dueMissing: boolean;
  duplicateOf: DupRef[]; conflicts: Conflict[];
  /** ids of duplicates / conflicts a person dismissed: they are not flagged again */
  dismissed?: string[];
};
export type ExternalRef = { provider: "trello" | "github" | "jira"; id: string; url: string };

export type MeetingItem = {
  id: string; itemType: ItemType; title: string; description: string;
  assigneeId: string | null; assigneeName: string | null; dueDate: string | null; priority: "normal" | "urgent";
  kind: Kind; label: Label; confidence: number; reason: string; quote: string; evidence: number[];
  unverified: boolean; followUp: boolean;
  /** A duplicate of an existing task: no second task was made, commitmentId points at the existing one. */
  merged?: boolean;
  /** undefined only on rows written before approval existed; the next sync decides it */
  approval?: Approval; approvedBy?: string | null; approvedAt?: string | null; rejectedBy?: string | null; rejectedAt?: string | null;
  ambiguity: Ambiguity;
  commitmentId: string | null;
  externalRefs: ExternalRef[];
  /** what was said about the date when it could not be resolved */
  dueText?: string | null;
  jiraKey?: string | null; jiraUrl?: string | null;
};
/** Kept for older callers. */
export type MeetingTask = MeetingItem;

export const emptyAmbiguity = (): Ambiguity => ({ ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [] });
export const isAmbiguous = (i: Pick<MeetingItem, "ambiguity">) => {
  const a = i.ambiguity;
  return a.ownerMissing || a.ownerAmbiguous || a.duplicateOf.length > 0 || a.conflicts.length > 0;
};

const clamp01 = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Reads whatever is stored (old rows have only title/description/assignee/due) into full items. Never throws. */
export function asItems(meetingId: string, value: unknown): MeetingItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const t = (raw ?? {}) as Partial<MeetingItem> & Record<string, any>;
    // Old rows predate ids. The deterministic fallback lets them take part in delivery safely.
    const id = typeof t.id === "string" && t.id ? t.id : `mtask_${createHash("sha256").update(`${meetingId}:${index}:${t.title ?? ""}`).digest("hex").slice(0, 24)}`;
    const legacyQuote = /(?:^|\n)Said: “([^”]*)”/.exec(str(t.description))?.[1] ?? "";
    const itemType: ItemType = t.itemType === "decision" || t.itemType === "question" ? t.itemType : "task";
    const kind: Kind = t.kind === "suggestion" || t.kind === "question" ? t.kind : "commitment";
    const a = (t.ambiguity ?? {}) as Partial<Ambiguity>;
    return {
      id, itemType, title: str(t.title) || "Untitled task",
      description: str(t.description).split("\n").filter((l) => !/^Said: “/.test(l)).join("\n"),
      assigneeId: t.assigneeId ?? null, assigneeName: t.assigneeName ?? null, dueDate: t.dueDate ?? null,
      priority: t.priority === "urgent" ? "urgent" : "normal", kind,
      label: (["confirmed", "tentative", "suggestion", "question"] as const).includes(t.label as Label) ? (t.label as Label) : kind === "commitment" ? "confirmed" : kind === "question" ? "question" : "suggestion",
      confidence: clamp01(t.confidence, 0.75), reason: str(t.reason), quote: str(t.quote) || legacyQuote,
      evidence: Array.isArray(t.evidence) ? t.evidence.filter((n): n is number => Number.isInteger(n)) : [],
      unverified: t.unverified === true, followUp: t.followUp === true, ...(t.merged === true ? { merged: true } : {}),
      ...(t.approval === "proposed" || t.approval === "approved" || t.approval === "rejected" ? { approval: t.approval } : (t as any).approval === "auto" ? { approval: "approved" as const } : {}),
      approvedBy: t.approvedBy ?? null, approvedAt: t.approvedAt ?? null, rejectedBy: t.rejectedBy ?? null, rejectedAt: t.rejectedAt ?? null,
      ambiguity: {
        ownerMissing: a.ownerMissing === true, ownerAmbiguous: a.ownerAmbiguous === true, ownerCandidates: Array.isArray(a.ownerCandidates) ? a.ownerCandidates : [],
        dueMissing: a.dueMissing === true, duplicateOf: Array.isArray(a.duplicateOf) ? a.duplicateOf : [], conflicts: Array.isArray(a.conflicts) ? a.conflicts : [],
        ...(Array.isArray(a.dismissed) ? { dismissed: strs(a.dismissed) } : {}),
      },
      commitmentId: t.commitmentId ?? null, externalRefs: Array.isArray(t.externalRefs) ? t.externalRefs : [],
      dueText: t.dueText ?? null, jiraKey: t.jiraKey ?? null, jiraUrl: t.jiraUrl ?? null,
    };
  });
}

// ---------- cue pre-pass ----------
const STRONG = /\b(i'll|i will|we'll|we will|i am going to|i'm going to|i can take|i'll take|i've got (this|it)|take this|you take|you'll take|on it|will (do|send|take|handle|own|check|prepare|share|set up|follow up|fix|write|book)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|tomorrow|end of|next|\d)|is on|handles?|assigned to|owns?|responsible for|has to)\b/i;
const WEAK = /\b(maybe|might|could we|we could|we should|should we|should probably|perhaps|probably|i guess|if we|would be nice|let's see|thinking (about|of)|consider|try to|hopefully|not sure|possibly|someday|at some point|we may|may be|someone should|somebody should|someone needs to|somebody needs to|i think i can)\b/i;
export const cues = (text: string) => ({ strong: STRONG.test(text), weak: WEAK.test(text) });

/**
 * Cross-checks the model's classification against the words that were actually said. It can only DOWNGRADE: a hedge ("maybe", "we could")
 * with no firm cue makes a "commitment" a suggestion; "I'll try to" keeps it but tentative. The model's reading is never raised.
 */
export function crossCheck<T extends Pick<MeetingItem, "kind" | "label" | "confidence" | "quote" | "title" | "itemType" | "assigneeId" | "dueDate">>(item: T): T {
  if (item.itemType !== "task" || item.kind === "question") return item;
  const c = cues(item.quote || item.title);
  if (item.kind === "commitment" && c.weak && !c.strong) return { ...item, kind: "suggestion", label: "suggestion", confidence: Math.min(item.confidence, 0.45) };
  if (item.kind === "commitment" && c.weak && c.strong) return { ...item, label: "tentative", confidence: Math.min(item.confidence, 0.65) };
  if (item.kind === "suggestion" && item.label === "confirmed") return { ...item, label: "suggestion" };
  // calibration floor: firm words ("I'll ... by Friday", "you take ...") with a named owner are never scored as a coin flip
  if (item.kind === "commitment" && c.strong && !c.weak && item.assigneeId) return { ...item, confidence: Math.max(item.confidence, item.dueDate ? 0.8 : 0.7) };
  return item;
}

// ---------- gate ----------
export const DEFAULT_AUTO_CONFIDENCE = 0.6;
export const clampThreshold = (n: number) => Math.min(0.95, Math.max(0.3, Number.isFinite(n) ? n : DEFAULT_AUTO_CONFIDENCE));
/**
 * Auto mode: only LOW-CONFIDENCE items need a human. A verified commitment (or decision) at/above the threshold becomes a task at once, when
 * its owner is resolved with certainty (no owner = nobody to assign: it stays proposed and the organizer is asked "Who owns this?").
 * Duplicates (auto-merged) and conflicts (created, flagged) do NOT block. Suggestions and questions never become tasks by themselves.
 */
export function autoApproves(i: MeetingItem, mode: "auto" | "approve", threshold = DEFAULT_AUTO_CONFIDENCE): boolean {
  if (mode !== "auto" || i.unverified || i.confidence < threshold) return false;
  if (i.itemType === "decision") return true;
  return i.itemType === "task" && i.kind === "commitment" && !!i.assigneeId && !i.ambiguity.ownerAmbiguous && !i.ambiguity.ownerMissing;
}

export const counts = (items: MeetingItem[]) => {
  const live = items.filter((i) => i.approval !== "rejected");
  const tasks = live.filter((i) => i.itemType === "task");
  return {
    confirmed: tasks.filter((i) => i.label === "confirmed").length,
    tentative: tasks.filter((i) => i.label === "tentative").length,
    suggestions: tasks.filter((i) => i.label === "suggestion").length,
    questions: live.filter((i) => i.itemType === "question").length,
    unassigned: tasks.filter((i) => !i.assigneeId).length,
    noDue: tasks.filter((i) => !i.dueDate).length,
    duplicates: live.filter((i) => i.ambiguity.duplicateOf.length > 0).length,
    conflicts: live.filter((i) => i.ambiguity.conflicts.length > 0).length,
  };
};

// ---------- urgency and dates ----------
const URGENT = /\b(urgent|asap|a\.s\.a\.p|immediately|right away|top priority|critical|blocker)\b/i;
export const isUrgent = (t: Pick<MeetingItem, "title" | "priority" | "quote">) => t.priority === "urgent" || URGENT.test(`${t.title} ${t.quote}`);

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** ISO date (YYYY-MM-DD) for what was said, resolved against the meeting date; null when it cannot be resolved with confidence. */
export function normalizeDue(raw: string | null | undefined, ref: Date): string | null {
  const s = raw?.trim().toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) { const d = new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!)); return Number.isNaN(d.getTime()) || ymd(d) !== iso[0] ? null : iso[0]; }
  if (/\b(today|tonight|eod|end of (the )?day)\b/.test(s)) return ymd(base);
  if (/\btomorrow\b/.test(s)) return ymd(addDays(base, 1));
  const rel = /\bin (\d{1,2}) (day|days|week|weeks)\b/.exec(s);
  if (rel) return ymd(addDays(base, +rel[1]! * (rel[2]!.startsWith("week") ? 7 : 1)));
  if (/\b(end of (the )?week|eow)\b/.test(s)) return ymd(addDays(base, (5 - base.getUTCDay() + 7) % 7));
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})\b/.exec(s) ?? /\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(s);
  if (md) {
    const [mon, day] = MONTHS.includes(md[1]!) ? [md[1]!, +md[2]!] : [md[2]!, +md[1]!];
    let d = new Date(Date.UTC(base.getUTCFullYear(), MONTHS.indexOf(mon), day));
    if (d.getUTCMonth() !== MONTHS.indexOf(mon)) return null;
    if (d.getTime() < base.getTime() - 86_400_000) d = new Date(Date.UTC(base.getUTCFullYear() + 1, MONTHS.indexOf(mon), day));
    return ymd(d);
  }
  const wd = /\b(next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(s);
  if (wd) {
    const delta = (WEEKDAYS.indexOf(wd[2]!) - base.getUTCDay() + 7) % 7 || 7;
    return ymd(addDays(base, delta + (wd[1] === "next " ? 7 : 0)));
  }
  return null;
}
export const dueAtOf = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T23:59:00Z`) : null);

// ---------- text similarity ----------
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
/** Token Jaccard 0..1. */
export function jaccard(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
export const similar = (a: string, b: string) => jaccard(a, b) >= 0.6;
