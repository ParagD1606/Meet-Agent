// Meeting-extraction scorer (pure, no LLM, no DB). See docs/qa/meeting-eval.md for the metric definitions.
import { makeSource, quoteSupported } from "../../src/meetings/verify";

export const LABELS = ["confirmed", "tentative", "suggestion", "question"] as const;
export type Label = (typeof LABELS)[number];
export const SOURCES = ["AMI-style", "QMSum-style", "synthetic"] as const;

export type GoldTask = { title: string; owner: string | null; due: string | null; label: Label; followUp?: boolean };
export type Fixture = {
  id: string; title: string; source: (typeof SOURCES)[number]; date: string; participants: string[];
  transcript: { speaker: string; text: string }[];
  gold: { decisions: { text: string }[]; tasks: GoldTask[]; duplicates: [number, number][]; conflicts: { a: number; b: number; type: "owner" | "due" }[] };
};

/** One predicted item, already normalised by the adapter. Optional fields are absent when the pipeline does not produce them. */
export type PredTask = {
  title: string; owner: string | null; due: string | null; label: Label | null; quote?: string | null;
  /** Index into the same Pred.tasks array this item duplicates / conflicts with, when the pipeline says so. */
  duplicateOf?: number | null; conflictsWith?: number[];
  /** Pipeline flagged a duplicate/conflict but the counterpart is not in this meeting (an older task or another meeting). */
  dupFlag?: boolean; conflictFlag?: boolean;
  ambiguity?: { ownerMissing?: boolean; ownerAmbiguous?: boolean } | null; approval?: string | null;
};
export type Capabilities = { classification: boolean; duplicates: boolean; conflicts: boolean; quotes: boolean; approval: boolean };
export type Pred = { tasks: PredTask[]; decisions: { text: string; quote?: string | null }[]; capabilities: Capabilities };

// ---------- similarity ----------
const STOP = new Set("a an the to of for on in and or with by that this it is be we our us up at as from will please can would should".split(" "));
const stem = (w: string) => (w.length > 4 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 3 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 3 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
export const tokens = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem);

/** Token-set Jaccard in [0,1]. Two empty strings score 0 (nothing to match on), identical non-empty strings score 1. */
export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export type Similarity = (a: string, b: string) => number;
export const MATCH_THRESHOLD = 0.5;
export const DECISION_THRESHOLD = 0.4;

/** Same person: equal names, or one name's tokens are a subset of the other's ("Hannah" ~ "Hannah Cole"). Null only equals null. */
export function sameOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const A = a.toLowerCase().split(/\s+/).filter(Boolean), B = b.toLowerCase().split(/\s+/).filter(Boolean);
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.length > 0 && s.every((t) => l.includes(t));
}

// ---------- matching ----------
export type Matching = { assign: (number | -1)[]; any: (number | -1)[]; predAny: boolean[] };

/** assign: greedy one-to-one gold->pred by similarity (ties broken by owner/due agreement); any: best pred >= threshold ignoring one-to-one. */
export function matchTasks(gold: GoldTask[], pred: PredTask[], threshold = MATCH_THRESHOLD, sim: Similarity = jaccard): Matching {
  const S = gold.map((g) => pred.map((p) => sim(g.title, p.title)));
  const edges: { i: number; j: number; s: number; agree: number }[] = [];
  gold.forEach((g, i) => pred.forEach((p, j) => {
    if (S[i]![j]! >= threshold) edges.push({ i, j, s: S[i]![j]!, agree: (sameOwner(g.owner, p.owner) ? 1 : 0) + (g.due === p.due ? 1 : 0) });
  }));
  edges.sort((x, y) => y.s - x.s || y.agree - x.agree || x.i - y.i || x.j - y.j);
  const assign: (number | -1)[] = gold.map(() => -1);
  const taken = new Set<number>();
  for (const e of edges) if (assign[e.i] === -1 && !taken.has(e.j)) { assign[e.i] = e.j; taken.add(e.j); }
  const any = gold.map((_, i) => { let best = -1, bs = 0; pred.forEach((_p, j) => { if (S[i]![j]! >= threshold && S[i]![j]! > bs) { bs = S[i]![j]!; best = j; } }); return best; });
  const predAny = pred.map((_, j) => gold.some((_g, i) => S[i]![j]! >= threshold));
  return { assign, any, predAny };
}

// ---------- per-meeting counts ----------
export type Counts = {
  meetings: number; goldTasks: number; predTasks: number; goldHit: number; predHit: number; pairs: number;
  ownerOk: number; ownerNamed: number; ownerNamedOk: number; dueOk: number; dueDated: number; dueDatedOk: number;
  labelN: number; labelOk: number; confusion: number[][];
  goldDecisions: number; predDecisions: number; decGoldHit: number; decPredHit: number;
  dupPlanted: number; dupDetected: number; dupFlagged: number; dupFalse: number; confPlanted: number; confDetected: number;
  quoteN: number; quoteUnsupported: number; ambFlagged: number; ambSafe: number;
  caps: Capabilities; ms: number[];
};
export const emptyCounts = (): Counts => ({
  meetings: 0, goldTasks: 0, predTasks: 0, goldHit: 0, predHit: 0, pairs: 0, ownerOk: 0, ownerNamed: 0, ownerNamedOk: 0, dueOk: 0, dueDated: 0, dueDatedOk: 0,
  labelN: 0, labelOk: 0, confusion: LABELS.map(() => LABELS.map(() => 0)), goldDecisions: 0, predDecisions: 0, decGoldHit: 0, decPredHit: 0,
  dupPlanted: 0, dupDetected: 0, dupFlagged: 0, dupFalse: 0, confPlanted: 0, confDetected: 0, quoteN: 0, quoteUnsupported: 0, ambFlagged: 0, ambSafe: 0,
  caps: { classification: false, duplicates: false, conflicts: false, quotes: false, approval: false }, ms: [],
});

const transcriptText = (fx: Fixture) => fx.transcript.map((l) => `${l.speaker}: ${l.text}`).join("\n");

export function scoreMeeting(fx: Fixture, pred: Pred, opts: { ms?: number; sim?: Similarity; threshold?: number } = {}): Counts {
  const c = emptyCounts();
  const { gold } = fx;
  const m = matchTasks(gold.tasks, pred.tasks, opts.threshold ?? MATCH_THRESHOLD, opts.sim);
  c.meetings = 1; c.goldTasks = gold.tasks.length; c.predTasks = pred.tasks.length; c.caps = { ...pred.capabilities }; c.ms = opts.ms == null ? [] : [opts.ms];
  c.goldHit = m.any.filter((j) => j >= 0).length;
  c.predHit = m.predAny.filter(Boolean).length;
  gold.tasks.forEach((g, i) => {
    const j = m.assign[i]!;
    if (j < 0) return;
    const p = pred.tasks[j]!;
    c.pairs++;
    if (sameOwner(g.owner, p.owner)) c.ownerOk++;
    if (g.owner) { c.ownerNamed++; if (sameOwner(g.owner, p.owner)) c.ownerNamedOk++; }
    if (g.due === p.due) c.dueOk++;
    if (g.due) { c.dueDated++; if (g.due === p.due) c.dueDatedOk++; }
    if (p.label) {
      c.labelN++;
      c.confusion[LABELS.indexOf(g.label)]![LABELS.indexOf(p.label)]!++;
      if (p.label === g.label) c.labelOk++;
    }
  });
  // decisions
  c.goldDecisions = gold.decisions.length; c.predDecisions = pred.decisions.length;
  c.decGoldHit = gold.decisions.filter((g) => pred.decisions.some((p) => (opts.sim ?? jaccard)(g.text, p.text) >= DECISION_THRESHOLD)).length;
  c.decPredHit = pred.decisions.filter((p) => gold.decisions.some((g) => (opts.sim ?? jaccard)(g.text, p.text) >= DECISION_THRESHOLD)).length;
  // duplicates / conflicts. A pair's predicted counterparts: the one-to-one match, else the best match (so a merged duplicate resolves to the same item).
  const at = (i: number) => (m.assign[i]! >= 0 ? m.assign[i]! : m.any[i]!);
  const goldPair = new Set(gold.duplicates.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
  c.dupPlanted = gold.duplicates.length;
  for (const [a, b] of gold.duplicates) {
    const pa = at(a), pb = at(b);
    if (pa < 0 || pb < 0) continue;
    const merged = pa === pb;
    const linked = pred.tasks[pa]!.duplicateOf === pb || pred.tasks[pb]!.duplicateOf === pa;
    const unresolved = (pred.tasks[pa]!.dupFlag || pred.tasks[pb]!.dupFlag) === true;
    if (merged || linked || unresolved) c.dupDetected++;
  }
  // gold index per predicted item (one-to-one match) to judge whether a flagged pair is a planted one
  const goldOf = new Map<number, number>();
  m.assign.forEach((j, i) => { if (j >= 0) goldOf.set(j, i); });
  pred.tasks.forEach((p, j) => {
    const flagged = (p.duplicateOf != null && p.duplicateOf >= 0) || p.dupFlag === true;
    if (!flagged) return;
    c.dupFlagged++;
    const gi = goldOf.get(j), gk = p.duplicateOf != null ? goldOf.get(p.duplicateOf) : undefined;
    const planted = gi != null && (gk != null ? goldPair.has(`${Math.min(gi, gk)}:${Math.max(gi, gk)}`) : gold.duplicates.some(([a, b]) => a === gi || b === gi));
    if (!planted) c.dupFalse++;
  });
  c.confPlanted = gold.conflicts.length;
  for (const { a, b } of gold.conflicts) {
    const pa = at(a), pb = at(b);
    if (pa < 0 || pb < 0 || pa === pb) continue;
    const A = pred.tasks[pa]!, B = pred.tasks[pb]!;
    if (A.conflictsWith?.includes(pb) || B.conflictsWith?.includes(pa) || (A.conflictFlag && B.conflictFlag)) c.confDetected++;
  }
  // grounding + approval safety
  if (pred.capabilities.quotes) {
    const src = makeSource(transcriptText(fx));
    for (const p of pred.tasks) { c.quoteN++; if (!p.quote || !quoteSupported(src, p.quote)) c.quoteUnsupported++; }
  }
  if (pred.capabilities.approval) {
    for (const p of pred.tasks) {
      const risky = p.ambiguity?.ownerMissing || p.ambiguity?.ownerAmbiguous || (p.duplicateOf != null && p.duplicateOf >= 0) || p.dupFlag || (p.conflictsWith?.length ?? 0) > 0 || p.conflictFlag;
      if (!risky) continue;
      c.ambFlagged++;
      if (p.approval !== "approved") c.ambSafe++;
    }
  }
  return c;
}

export function addCounts(a: Counts, b: Counts): Counts {
  const r = emptyCounts();
  for (const k of Object.keys(r) as (keyof Counts)[]) {
    if (k === "confusion") r.confusion = a.confusion.map((row, i) => row.map((v, j) => v + b.confusion[i]![j]!));
    else if (k === "ms") r.ms = [...a.ms, ...b.ms];
    else if (k === "caps") r.caps = { classification: a.caps.classification || b.caps.classification, duplicates: a.caps.duplicates || b.caps.duplicates, conflicts: a.caps.conflicts || b.caps.conflicts, quotes: a.caps.quotes || b.caps.quotes, approval: a.caps.approval || b.caps.approval };
    else (r[k] as number) = (a[k] as number) + (b[k] as number);
  }
  return r;
}

// ---------- metrics ----------
const round = (n: number) => Math.round(n * 1000) / 1000;
const ratio = (n: number, d: number): number | null => (d > 0 ? round(n / d) : null);
const f1 = (p: number | null, r: number | null) => (p == null || r == null ? null : p + r === 0 ? 0 : round((2 * p * r) / (p + r)));

export type Metrics = {
  meetings: number; taskPrecision: number | null; taskRecall: number | null; taskF1: number | null;
  ownerAccuracy: number | null; ownerAccuracyNamed: number | null; dueAccuracy: number | null; dueAccuracyDated: number | null;
  classificationAccuracy: number | null; confusion: number[][] | null;
  decisionPrecision: number | null; decisionRecall: number | null; decisionF1: number | null;
  duplicateDetectionRate: number | null; falseDuplicateRate: number | null; conflictDetectionRate: number | null;
  hallucinationRate: number | null; approvalSafety: number | null;
  latencyMs: { mean: number; p95: number } | null;
};

/** Ratios over pooled counts (micro-average). null means "n/a": nothing to measure, or the pipeline does not emit that field. */
export function metrics(c: Counts): Metrics {
  const p = ratio(c.predHit, c.predTasks), r = ratio(c.goldHit, c.goldTasks);
  const dp = ratio(c.decPredHit, c.predDecisions), dr = ratio(c.decGoldHit, c.goldDecisions);
  const ms = [...c.ms].sort((a, b) => a - b);
  return {
    meetings: c.meetings, taskPrecision: p, taskRecall: r, taskF1: f1(p, r),
    ownerAccuracy: ratio(c.ownerOk, c.pairs), ownerAccuracyNamed: ratio(c.ownerNamedOk, c.ownerNamed), dueAccuracy: ratio(c.dueOk, c.pairs), dueAccuracyDated: ratio(c.dueDatedOk, c.dueDated),
    classificationAccuracy: c.caps.classification ? ratio(c.labelOk, c.labelN) : null, confusion: c.caps.classification && c.labelN ? c.confusion : null,
    decisionPrecision: dp, decisionRecall: dr, decisionF1: f1(dp, dr),
    duplicateDetectionRate: c.caps.duplicates ? ratio(c.dupDetected, c.dupPlanted) : null,
    falseDuplicateRate: c.caps.duplicates ? round(c.dupFlagged ? c.dupFalse / c.dupFlagged : 0) : null,
    conflictDetectionRate: c.caps.conflicts ? ratio(c.confDetected, c.confPlanted) : null,
    hallucinationRate: c.caps.quotes ? ratio(c.quoteUnsupported, c.quoteN) : null,
    approvalSafety: c.caps.approval ? (c.ambFlagged ? round(c.ambSafe / c.ambFlagged) : 1) : null,
    latencyMs: ms.length ? { mean: round(ms.reduce((a, b) => a + b, 0) / ms.length), p95: round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]!) } : null,
  };
}

// ---------- reporting ----------
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
export function markdownTable(m: Metrics): string {
  const rows: [string, string][] = [
    ["Task precision", pct(m.taskPrecision)], ["Task recall", pct(m.taskRecall)], ["Task F1", pct(m.taskF1)],
    ["Owner accuracy (matched tasks; null owner correct when gold null)", pct(m.ownerAccuracy)], ["Owner accuracy (gold has an owner)", pct(m.ownerAccuracyNamed)],
    ["Due-date exact match (matched tasks)", pct(m.dueAccuracy)], ["Due-date exact match (gold has a date)", pct(m.dueAccuracyDated)],
    ["Classification accuracy (4 labels)", pct(m.classificationAccuracy)],
    ["Decision precision", pct(m.decisionPrecision)], ["Decision recall", pct(m.decisionRecall)], ["Decision F1", pct(m.decisionF1)],
    ["Duplicate detection rate", pct(m.duplicateDetectionRate)], ["False-duplicate rate", pct(m.falseDuplicateRate)], ["Conflict detection rate", pct(m.conflictDetectionRate)],
    ["Hallucination rate (no supporting quote)", pct(m.hallucinationRate)], ["Approval safety (ambiguous items not auto-approved)", pct(m.approvalSafety)],
    ["Latency per meeting (mean / p95)", m.latencyMs ? `${Math.round(m.latencyMs.mean)} ms / ${Math.round(m.latencyMs.p95)} ms` : "n/a"],
  ];
  return `| Metric | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
}
export function confusionTable(conf: number[][] | null): string {
  if (!conf) return "_n/a (the pipeline output has no label field)_";
  return `| gold \\ predicted | ${LABELS.join(" | ")} |\n|---|${LABELS.map(() => "---").join("|")}|\n${LABELS.map((l, i) => `| **${l}** | ${conf[i]!.join(" | ")} |`).join("\n")}`;
}

// ---------- fixture validation ----------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Returns a list of schema problems (empty when valid). */
export function validateFixture(fx: Fixture): string[] {
  const e: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) e.push(`${fx.id}: ${msg}`); };
  need(typeof fx.id === "string" && /^[a-z0-9-]+$/.test(fx.id), "id must be kebab-case");
  need(typeof fx.title === "string" && fx.title.length > 0, "title");
  need((SOURCES as readonly string[]).includes(fx.source), "source");
  need(ISO.test(fx.date) && !Number.isNaN(Date.parse(fx.date)), "date must be YYYY-MM-DD");
  need(Array.isArray(fx.participants) && fx.participants.length >= 2, "participants");
  need(Array.isArray(fx.transcript) && fx.transcript.length >= 1 && fx.transcript.every((l) => l.speaker && l.text && fx.participants.includes(l.speaker)), "transcript lines need speaker (a participant) and text");
  const n = fx.gold?.tasks?.length ?? 0;
  need(Array.isArray(fx.gold?.decisions) && fx.gold.decisions.every((d) => d.text), "gold.decisions");
  need(n > 0 && fx.gold.tasks.every((t) => t.title && (LABELS as readonly string[]).includes(t.label) && (t.owner === null || fx.participants.includes(t.owner)) && (t.due === null || ISO.test(t.due))), "gold.tasks need title, label, owner (participant|null), due (ISO|null)");
  need(fx.gold.duplicates.every(([a, b]) => a !== b && a >= 0 && b >= 0 && a < n && b < n), "gold.duplicates indices");
  need(fx.gold.conflicts.every((k) => k.a !== k.b && k.a >= 0 && k.b >= 0 && k.a < n && k.b < n && (k.type === "owner" || k.type === "due")), "gold.conflicts indices/type");
  return e;
}
