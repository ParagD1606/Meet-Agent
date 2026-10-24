// Deterministic gate for the PS-4 meeting evaluation harness (no LLM, no DB): fixtures are valid, the scorer is correct, the adapter normalises
// both pipeline shapes, baseline.json has the expected shape. The real-model run is `bun run scripts/meeting-eval.ts` (docs/qa/meeting-eval.md).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { normalize } from "./adapter";
import { addCounts, type Fixture, jaccard, LABELS, matchTasks, metrics, type Pred, type PredTask, sameOwner, scoreMeeting, validateFixture } from "./lib";

const dir = new URL("./gold/", import.meta.url).pathname;
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(dir + f, "utf8")));
const caps = { classification: true, duplicates: true, conflicts: true, quotes: true, approval: true };
const byId = (id: string) => fixtures.find((f) => f.id === id)!;
/** A prediction identical to the gold (every task has an owner/due/label), optionally with a supporting quote. */
const perfect = (fx: Fixture, extra: Partial<PredTask> = {}): Pred => ({
  tasks: fx.gold.tasks.map((t) => ({ title: t.title, owner: t.owner, due: t.due, label: t.label, ...extra })),
  decisions: fx.gold.decisions.map((d) => ({ text: d.text })), capabilities: { ...caps },
});

describe("gold fixtures", () => {
  test("at least 10 meetings, unique ids, valid schema", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    expect(fixtures.flatMap(validateFixture)).toEqual([]);
  });
  test("realistic length and coverage of every planted phenomenon", () => {
    for (const f of fixtures) expect(f.transcript.length, f.id).toBeGreaterThanOrEqual(55);
    for (const s of ["AMI-style", "QMSum-style", "synthetic"]) expect(fixtures.some((f) => f.source === s), s).toBe(true);
    const tasks = fixtures.flatMap((f) => f.gold.tasks);
    for (const l of LABELS) expect(tasks.filter((t) => t.label === l).length, l).toBeGreaterThanOrEqual(5);
    expect(tasks.some((t) => t.owner === null && t.label === "confirmed")).toBe(false); // a confirmed commitment always names its owner in the gold
    expect(fixtures.flatMap((f) => f.gold.duplicates).length).toBeGreaterThanOrEqual(3);
    const conflicts = fixtures.flatMap((f) => f.gold.conflicts);
    expect(conflicts.some((c) => c.type === "due") && conflicts.some((c) => c.type === "owner")).toBe(true);
    expect(tasks.filter((t) => t.due).length).toBeGreaterThanOrEqual(25);
    expect(fixtures.filter((f) => f.id.includes("hard")).length).toBeGreaterThanOrEqual(1);
    expect(byId("syn-brainstorm").gold.tasks.length).toBeLessThanOrEqual(3); // negatives-heavy: few true tasks in a long transcript
  });
  test("gold due dates are consistent with the meeting date (not before it)", () => {
    for (const f of fixtures) for (const t of f.gold.tasks) if (t.due) expect(t.due >= f.date, `${f.id}: ${t.title}`).toBe(true);
  });
  test("planted duplicates share a title; planted conflicts differ in the stated field", () => {
    for (const f of fixtures) {
      for (const [a, b] of f.gold.duplicates) expect(jaccard(f.gold.tasks[a]!.title, f.gold.tasks[b]!.title), `${f.id} ${a}/${b}`).toBeGreaterThanOrEqual(0.5);
      for (const c of f.gold.conflicts) {
        const A = f.gold.tasks[c.a]!, B = f.gold.tasks[c.b]!;
        expect(c.type === "due" ? A.due !== B.due : A.owner !== B.owner, `${f.id} ${c.a}/${c.b}`).toBe(true);
      }
    }
  });
});

describe("jaccard / owner / matching", () => {
  test("edge cases", () => {
    expect(jaccard("", "")).toBe(0);
    expect(jaccard("the a of", "to for")).toBe(0); // stop-words only
    expect(jaccard("Send the budget", "send the BUDGET!")).toBe(1);
    expect(jaccard("send budget", "review roadmap")).toBe(0);
    expect(jaccard("send the budget report", "report budget send")).toBe(1); // order and stop-words ignored
    expect(jaccard("sending budgets", "send budget")).toBe(1); // light stemming
    expect(jaccard("alpha beta gamma delta", "alpha beta x1 y1")).toBeCloseTo(2 / 6, 5); // 2 shared of 6 distinct
  });
  test("sameOwner: null only equals null, first name matches full name", () => {
    expect(sameOwner(null, null)).toBe(true);
    expect(sameOwner(null, "Sam")).toBe(false);
    expect(sameOwner("Hannah", "Hannah Cole")).toBe(true);
    expect(sameOwner("hannah cole", "Hannah Cole")).toBe(true);
    expect(sameOwner("Hannah", "Priya Nair")).toBe(false);
  });
  test("matching is one-to-one for attributes but a merged duplicate still counts as recalled", () => {
    const g = [{ title: "Send the order form", owner: "A", due: "2026-01-02", label: "confirmed" as const }, { title: "Send the order form", owner: "A", due: "2026-01-05", label: "confirmed" as const }];
    const p: PredTask[] = [{ title: "Send order form", owner: "A", due: "2026-01-05", label: "confirmed" }];
    const m = matchTasks(g, p);
    expect(m.assign).toEqual([-1, 0]); // tie broken by due agreement
    expect(m.any).toEqual([0, 0]);
  });
});

describe("scoreMeeting", () => {
  test("gold scored against itself is perfect", () => {
    const c = fixtures.map((f) => scoreMeeting(f, perfect(f))).reduce(addCounts);
    const m = metrics(c);
    expect([m.taskPrecision, m.taskRecall, m.taskF1, m.ownerAccuracy, m.dueAccuracy, m.classificationAccuracy, m.decisionF1]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) expect(m.confusion![i]![j]).toBe(0);
  });
  test("confusion matrix puts a mislabelled task in the right cell; precision and recall react to extras and misses", () => {
    const f = byId("ami-kickoff");
    const p = perfect(f);
    p.tasks[3]!.label = "confirmed"; // gold suggestion -> predicted confirmed
    p.tasks.pop(); // drop the last gold task (confirmed minutes)
    p.tasks.push({ title: "Order pizza for everyone", owner: null, due: null, label: "tentative" }); // hallucinated extra
    const m = metrics(scoreMeeting(f, p));
    expect(m.confusion![LABELS.indexOf("suggestion")]![LABELS.indexOf("confirmed")]).toBe(1);
    expect(m.taskRecall).toBeCloseTo(5 / 6, 2);
    expect(m.taskPrecision).toBeCloseTo(5 / 6, 2);
    expect(m.classificationAccuracy).toBeCloseTo(4 / 5, 2);
  });
  test("owner null counts as correct when gold is null; wrong owner and wrong due are counted", () => {
    const f = byId("ami-kickoff");
    const p = perfect(f);
    p.tasks[0]!.owner = "Sam Whitaker"; // wrong owner
    p.tasks[1]!.due = "2026-03-07"; // wrong due
    const m = metrics(scoreMeeting(f, p));
    expect(m.ownerAccuracy).toBeCloseTo(5 / 6, 2);
    expect(m.ownerAccuracyNamed).toBeCloseTo(3 / 4, 2); // 4 named gold owners, one wrong
    expect(m.dueAccuracy).toBeCloseTo(5 / 6, 2);
    expect(m.dueAccuracyDated).toBeCloseTo(2 / 3, 2); // 3 dated gold tasks, one wrong
  });
  test("fields the pipeline does not emit are n/a, not zero", () => {
    const f = byId("ami-kickoff");
    const p = perfect(f);
    p.capabilities = { classification: false, duplicates: false, conflicts: false, quotes: false, approval: false };
    const m = metrics(scoreMeeting(f, p, { ms: 12 }));
    expect([m.classificationAccuracy, m.confusion, m.duplicateDetectionRate, m.falseDuplicateRate, m.conflictDetectionRate, m.hallucinationRate, m.approvalSafety]).toEqual([null, null, null, null, null, null, null]);
    expect(m.latencyMs).toEqual({ mean: 12, p95: 12 });
  });
  test("duplicate detection: flagged link, merged item and false flags", () => {
    const f = byId("ami-conceptual"); // duplicates [[0, 4]]
    const flagged = perfect(f); flagged.tasks[4]!.duplicateOf = 0;
    expect(metrics(scoreMeeting(f, flagged)).duplicateDetectionRate).toBe(1);
    expect(metrics(scoreMeeting(f, flagged)).falseDuplicateRate).toBe(0);
    const none = perfect(f);
    expect(metrics(scoreMeeting(f, none)).duplicateDetectionRate).toBe(0);
    const merged = perfect(f); merged.tasks.splice(4, 1); // pipeline merged the pair into one item
    expect(metrics(scoreMeeting(f, merged)).duplicateDetectionRate).toBe(1);
    const wrong = perfect(f); wrong.tasks[4]!.duplicateOf = 0; wrong.tasks[1]!.duplicateOf = 2; // one right, one false
    expect(metrics(scoreMeeting(f, wrong)).falseDuplicateRate).toBe(0.5);
  });
  test("conflict detection and hallucination (quote must really be in the transcript)", () => {
    const f = byId("ami-detailed"); // conflicts due 0/1, owner 2/3
    const p = perfect(f);
    p.tasks[0]!.conflictsWith = [1]; p.tasks[3]!.conflictsWith = [2];
    expect(metrics(scoreMeeting(f, p)).conflictDetectionRate).toBe(1);
    p.tasks[3]!.conflictsWith = [];
    expect(metrics(scoreMeeting(f, p)).conflictDetectionRate).toBe(0.5);
    const q = perfect(f);
    q.tasks.forEach((t, i) => { t.quote = i === 0 ? "Priya Nair: Friday the twentieth" : "the dragons are in the cloud"; });
    q.tasks[0]!.quote = "I'll finish the CAD drawing of the case by Friday";
    const m = metrics(scoreMeeting(f, q));
    expect(m.hallucinationRate).toBeCloseTo((f.gold.tasks.length - 1) / f.gold.tasks.length, 2);
  });
  test("approval safety: ambiguous items that are auto-approved are unsafe", () => {
    const f = byId("ami-kickoff");
    const p = perfect(f);
    p.tasks[3]!.ambiguity = { ownerMissing: true }; p.tasks[3]!.approval = "proposed";
    p.tasks[4]!.ambiguity = { ownerMissing: true }; p.tasks[4]!.approval = "approved";
    expect(metrics(scoreMeeting(f, p)).approvalSafety).toBe(0.5);
    expect(metrics(scoreMeeting(f, perfect(f))).approvalSafety).toBe(1); // nothing ambiguous: vacuously safe
  });
});

describe("adapter.normalize", () => {
  test("live shape: kind/label/title/assignee/due; questions become label question; decisions split out", () => {
    const p = normalize({ items: [
      { kind: "task", label: "confirmed", title: "Do X", assignee: "Sam", due: "2026-01-01" },
      { kind: "question", label: "suggestion", title: "Who does Y?", assignee: null, due: null },
      { kind: "decision", label: "confirmed", title: "Go with Z" },
    ] });
    expect(p.tasks.map((t) => t.label)).toEqual(["confirmed", "question"]);
    expect(p.tasks[0]).toMatchObject({ owner: "Sam", due: "2026-01-01" });
    expect(p.decisions).toEqual([{ text: "Go with Z", quote: null }]);
    expect(p.capabilities).toMatchObject({ classification: true, duplicates: false, approval: false });
  });
  test("unified MeetingItem shape: ambiguity, approval, quote, duplicate/conflict links by id", () => {
    const p = normalize({ items: [
      { id: "a", itemType: "task", kind: "commitment", label: "confirmed", title: "Send form", assigneeName: "Tom", dueDate: "2026-06-26", quote: "I will send the form", approval: "proposed", ambiguity: { ownerMissing: false, ownerAmbiguous: false, duplicateOf: null, conflicts: [{ id: "b" }] } },
      { id: "b", itemType: "task", kind: "commitment", label: "confirmed", title: "Send form", assigneeName: "Tom", dueDate: "2026-06-29", quote: "I will send the form on Monday", approval: "proposed", ambiguity: { ownerMissing: false, duplicateOf: "a", conflicts: ["a"] } },
    ] });
    expect(p.tasks[1]).toMatchObject({ duplicateOf: 0, conflictsWith: [0], approval: "proposed" });
    expect(p.tasks[0]!.conflictsWith).toEqual([1]);
    expect(p.capabilities).toEqual({ classification: true, duplicates: true, conflicts: true, quotes: true, approval: true });
  });
});

describe("baseline.json", () => {
  test("has the documented shape", async () => {
    const b = await Bun.file(new URL("./baseline.json", import.meta.url).pathname).json();
    expect(typeof b.model).toBe("string");
    expect(["final", "live"]).toContain(b.mode);
    expect(b.fixtures).toBe(fixtures.length);
    for (const k of ["taskPrecision", "taskRecall", "taskF1", "ownerAccuracy", "dueAccuracy", "classificationAccuracy", "decisionF1", "duplicateDetectionRate", "conflictDetectionRate", "hallucinationRate", "approvalSafety"]) {
      expect(k in b.metrics, k).toBe(true);
      expect(b.metrics[k] === null || (b.metrics[k] >= 0 && b.metrics[k] <= 1), k).toBe(true);
    }
  });
});
