/**
 * OFFLINE loader: QMSum (https://github.com/Yale-LILY/QMSum) -> meeting-eval fixtures.
 * Reads a LOCAL clone's data/ALL/{train,val,test}/*.json (or any dir of QMSum JSON). Never touches the network and refuses URLs; the data is not shipped here.
 *
 *   bun run scripts/meeting-eval-loaders/qmsum.ts <dir with QMSum json> [outDir=./gold-local] [--max 20]
 *
 * QMSum is a query-based summarisation set, not an action-item set. We use its queries as a RECALL PROXY: a query that asks about a decision
 * ("What did the group decide about ...?") yields a gold decision (its answer text); one about actions/next steps yields a gold task (owner/due
 * null, label confirmed). Precision against these is not meaningful because most real commitments are not annotated.
 * Run it with: bun run scripts/meeting-eval.ts --dir <outDir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../test/meeting-eval/lib";

type Query = { query: string; answer: string };
type Qm = { meeting_transcripts: { speaker: string; content: string }[]; general_query_list?: Query[]; specific_query_list?: Query[] };

const DECISION_Q = /\b(decid|decision|conclu|agree|settle)/i;
const ACTION_Q = /\b(action|assign|next step|to-?do|task|follow[- ]?up|responsib|plan to)/i;
const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);

export function qmsumFixture(id: string, j: Qm, date = "2026-01-05"): Fixture {
  const transcript = j.meeting_transcripts.map((t) => ({ speaker: t.speaker.trim() || "Unknown", text: t.content.trim() })).filter((t) => t.text);
  const queries = [...(j.general_query_list ?? []), ...(j.specific_query_list ?? [])];
  const decisions = queries.filter((q) => DECISION_Q.test(q.query) && q.answer).map((q) => ({ text: short(q.answer) }));
  const tasks = queries.filter((q) => ACTION_Q.test(q.query) && !DECISION_Q.test(q.query) && q.answer).map((q) => ({ title: short(q.answer), owner: null, due: null, label: "confirmed" as const }));
  return { id: `qmsum-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title: `QMSum ${id}`, source: "QMSum-style", date, participants: [...new Set(transcript.map((t) => t.speaker))], transcript, gold: { decisions, tasks, duplicates: [], conflicts: [] } };
}

export function loadQmsumDir(dir: string, max = Infinity): Fixture[] {
  if (/^[a-z]+:\/\//i.test(dir)) throw new Error("qmsum loader reads a local directory only; it never downloads anything");
  if (!existsSync(dir)) throw new Error(`not found: ${dir}`);
  const names = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? names(join(d, e.name)) : e.name.endsWith(".json") ? [join(d, e.name)] : []));
  const out: Fixture[] = [];
  for (const f of names(dir).sort()) {
    const j = JSON.parse(readFileSync(f, "utf8")) as Qm;
    if (!Array.isArray(j.meeting_transcripts)) continue;
    const fx = qmsumFixture(f.split("/").pop()!.replace(/\.json$/, ""), j);
    if (fx.gold.tasks.length || fx.gold.decisions.length) out.push(fx);
    if (out.length >= max) break;
  }
  return out;
}

if (import.meta.main) {
  const a = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  const mi = process.argv.indexOf("--max");
  if (!a[0]) { console.error("usage: bun run scripts/meeting-eval-loaders/qmsum.ts <dir with QMSum json> [outDir=./gold-local] [--max N]"); process.exit(1); }
  const out = a[1] ?? "./gold-local";
  const fx = loadQmsumDir(a[0], mi > 0 ? Number(process.argv[mi + 1]) : Infinity);
  mkdirSync(out, { recursive: true });
  for (const f of fx) writeFileSync(join(out, `${f.id}.json`), `${JSON.stringify(f, null, 1)}\n`);
  console.log(`wrote ${fx.length} QMSum fixtures to ${out} (local only: do not commit corpus data)`);
}
