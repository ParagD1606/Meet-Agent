// Thin adapter between the meeting pipeline (server/src/meetings/*) and the scorer. THE ONLY FILE TO RETARGET when the pipeline's exported
// names or output shape change.
//
//   mode "live"  -> analyzeLiveMeeting(lines, ctx, known, background) in src/meetings/index.ts: stateless, exported today. Items carry kind/label/title/
//                   assignee/due; quote/ambiguity are verified inside the pipeline and then dropped, so grounding metrics are n/a here.
//   mode "final" -> the unified final pass, tried in this order:
//                     1. src/meetings/analyze.ts `extractMeeting(text, { roster, names, ref })` -> { items: MeetingItem[] }, then (when present and a
//                        throwaway database is reachable) src/meetings/detect.ts `annotateItems(meetingRow, items, scopeTag)` for duplicate/conflict flags;
//                     2. an exported analyzeMeeting/analyzeFinalMeeting/analyzeTranscript in src/meetings/index.ts called as fn({ lines, title, ... }).
//                   If neither exists yet it falls back to the live analyzer and says so in `notes`.
// MEETING_EVAL_SRC=/abs/path/to/server/src/meetings points the adapter at another checkout's pipeline (dev only, for previewing unmerged work).
import type { Capabilities, Fixture, Label, Pred, PredTask } from "./lib";

export type Mode = "final" | "live";
export const FINAL_CANDIDATES = ["analyzeMeeting", "analyzeFinalMeeting", "analyzeTranscript"] as const;
export type Analysis = { pred: Pred; target: string; notes: string[]; raw: unknown };

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const LABEL_SET = new Set(["confirmed", "tentative", "suggestion", "question"]);

/** Accepts both the live shape ({kind,label,title,assignee,due}) and the stored MeetingItem shape ({itemType,assigneeName,dueDate,ambiguity,...}). */
export function normalize(raw: any): Pred {
  const list: any[] = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.tasks) ? [...raw.tasks, ...(Array.isArray(raw?.questions) ? raw.questions : [])] : [];
  const kindOf = (i: any): string => i.itemType ?? i.kind ?? "task"; // unified items: itemType task/decision/question, kind commitment/suggestion
  const tasksRaw = list.filter((i) => ["task", "question", "action"].includes(kindOf(i)));
  const decRaw = [
    ...list.filter((i) => kindOf(i) === "decision").map((i) => ({ text: s(i.title) ?? s(i.text) ?? "", quote: s(i.quote) })),
    ...(Array.isArray(raw?.decisions) ? raw.decisions.map((d: any) => ({ text: typeof d === "string" ? d : s(d?.text) ?? "", quote: typeof d === "string" ? null : s(d?.quote) })) : []),
  ].filter((d) => d.text);
  const ids = new Map<string, number>();
  tasksRaw.forEach((t, i) => { if (typeof t.id === "string") ids.set(t.id, i); });
  const link = (v: any): number | null =>
    typeof v === "string" ? (ids.get(v) ?? null)
      : v && typeof v === "object" ? (ids.get(v.id) ?? ids.get(v.with?.id) ?? null) : null;
  const tasks: PredTask[] = tasksRaw.map((t) => {
    const amb = t.ambiguity ?? null;
    const label: Label | null = kindOf(t) === "question" ? "question" : LABEL_SET.has(t.label) ? t.label : null;
    const conflicts: unknown[] = Array.isArray(amb?.conflicts) ? amb.conflicts : [];
    const one = amb?.duplicateOf ?? t.duplicateOf;
    const dups: unknown[] = Array.isArray(one) ? one : one ? [one] : [];
    return {
      title: s(t.title) ?? "", owner: s(t.assigneeName) ?? s(t.assignee) ?? s(t.owner), due: s(t.dueDate) ?? s(t.due), label, quote: s(t.quote),
      duplicateOf: link(dups[0]), dupFlag: dups.length > 0, conflictsWith: conflicts.map(link).filter((x): x is number => x != null), conflictFlag: conflicts.length > 0,
      ambiguity: amb ? { ownerMissing: !!amb.ownerMissing, ownerAmbiguous: !!amb.ownerAmbiguous } : null, approval: s(t.approval),
    };
  });
  const has = (f: (t: any) => boolean) => tasksRaw.some(f);
  const capabilities: Capabilities = {
    classification: has((t) => LABEL_SET.has(t.label) || kindOf(t) === "question"),
    duplicates: has((t) => t.ambiguity != null || "duplicateOf" in t), conflicts: has((t) => Array.isArray(t.ambiguity?.conflicts)),
    quotes: has((t) => "quote" in t && t.quote !== undefined), approval: has((t) => typeof t.approval === "string"),
  };
  return { tasks, decisions: decRaw, capabilities };
}

const base = () => process.env.MEETING_EVAL_SRC ?? new URL("../../src/meetings", import.meta.url).pathname;
const tryImport = async (name: string): Promise<Record<string, any> | null> => {
  const spec = `${base()}/${name}`; // variable specifier: the module may not exist yet in this tree
  try { return await import(spec); } catch { return null; }
};

/** The DB-backed pass may only run against a throwaway database (a 543x/546x test instance), never a real one. */
const dbOk = () => /543[0-9]|546[0-9]/.test(process.env.DATABASE_URL ?? "");

export async function analyze(fx: Fixture, mode: Mode): Promise<Analysis> {
  const lines = fx.transcript;
  const startedAt = `${fx.date}T09:00:00Z`;
  const text = lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
  const notes: string[] = [];
  if (mode === "final") {
    const an = await tryImport("analyze");
    if (typeof an?.extractMeeting === "function") {
      if (!dbOk()) throw new Error("final mode reads the users table: set DATABASE_URL to a throwaway database whose URL contains 543x/546x");
      const ex = await an.extractMeeting(text, { roster: [], names: fx.participants, ref: new Date(startedAt) });
      let items = ex.items;
      const det = await tryImport("detect");
      let annotated = false;
      if (typeof det?.annotateItems === "function") {
        try {
          const row = { id: `eval_${fx.id}`, channelId: "ext_eval", ownerId: "eval", organizerId: null, sourceFileId: `eval:${fx.id}`, title: fx.title, transcript: text, tasks: [], createdAt: new Date() };
          items = await det.annotateItems(row, items, "shared", { llm: 6 });
          annotated = true;
        } catch (e) { notes.push(`annotateItems failed (${String(e).slice(0, 120)}): duplicate/conflict metrics are n/a`); }
      } else notes.push("no annotateItems export: duplicate/conflict metrics are n/a");
      const pred = normalize({ items });
      pred.capabilities.duplicates = pred.capabilities.conflicts = annotated;
      return { pred, target: `extractMeeting${annotated ? "+annotateItems" : ""}`, notes, raw: ex };
    }
    const mod = await tryImport("index");
    const finalFn = FINAL_CANDIDATES.find((n) => typeof mod?.[n] === "function");
    if (finalFn) {
      const raw = await mod![finalFn]({ lines, title: fx.title, startedAt, roster: fx.participants, text });
      return { pred: normalize(raw), target: finalFn, notes, raw };
    }
    notes.push(`mode=final requested but the pipeline exports neither analyze.ts extractMeeting nor ${FINAL_CANDIDATES.join("/")} (the unified final pass is pending); scored the live analyzer instead.`);
  }
  const mod = await tryImport("index");
  if (typeof mod?.analyzeLiveMeeting !== "function") throw new Error("src/meetings/index.ts exports no analyzeLiveMeeting; retarget test/meeting-eval/adapter.ts");
  const raw = await mod.analyzeLiveMeeting(lines, { title: fx.title, startedAt, roster: fx.participants }, [], "");
  const pred = normalize(raw);
  // The live analyzer drops quote/ambiguity/approval after verifying them internally, so those metrics cannot be recomputed here.
  pred.capabilities = { classification: true, duplicates: false, conflicts: false, quotes: false, approval: false };
  notes.push("live analyzer: duplicate/conflict/approval/grounding metrics are n/a (fields not in its output); grounding is enforced inside the pipeline by quoteSupported.");
  return { pred, target: "analyzeLiveMeeting", notes, raw };
}
