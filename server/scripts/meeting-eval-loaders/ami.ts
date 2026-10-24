/**
 * OFFLINE loader: AMI Meeting Corpus (https://groups.inf.ed.ac.uk/ami/corpus/) -> meeting-eval fixtures.
 * Reads a LOCAL download of the "AMI manual annotations" package. It never touches the network and refuses URLs; the corpus is not shipped in this repo.
 *
 *   bun run scripts/meeting-eval-loaders/ami.ts <ami_public_manual dir> [outDir=./gold-local] [--max 20]
 *
 * Expected layout (searched recursively): `words/<meeting>.<A|B|C|D>.words.xml` (<w starttime=".." endtime="..">word</w>) and
 * `abstractive/<meeting>.abssumm.xml` (<decisions>, <actions>, <abstract> blocks of <sentence>). Written from the corpus documentation;
 * validated only on a hand-made sample (test/meeting-eval/loaders.test.ts), so check one real meeting before trusting a full run.
 *
 * Gold produced: decisions = the annotators' decision sentences, tasks = their action sentences (label confirmed, owner/due null: AMI has no
 * owners or dates), so recall against it is a PROXY for "did the system find the action items", and precision is not meaningful.
 * Run it with: bun run scripts/meeting-eval.ts --dir <outDir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../test/meeting-eval/lib";

const decode = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Words of one speaker's words.xml as {t, w}. Punctuation tokens are glued to the previous word. */
export function parseWords(xml: string): { t: number; w: string }[] {
  const out: { t: number; w: string }[] = [];
  for (const m of xml.matchAll(/<w\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w>)/g)) {
    const text = decode(m[2] ?? "");
    if (!text) continue;
    const t = Number(/starttime="([\d.]+)"/.exec(m[1]!)?.[1] ?? NaN);
    if (/punc="true"/.test(m[1]!) && out.length) { out[out.length - 1]!.w += text; continue; }
    if (Number.isFinite(t)) out.push({ t, w: text });
  }
  return out;
}

/** Sentences inside one <decisions>/<actions>/<abstract> block of an abssumm file. */
export function parseAbssumm(xml: string): { decisions: string[]; actions: string[] } {
  const block = (name: string) => {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? [...m[1]!.matchAll(/<sentence\b[^>]*>([\s\S]*?)<\/sentence>/g)].map((s) => decode(s[1]!)).filter(Boolean) : [];
  };
  return { decisions: block("decisions"), actions: block("actions") };
}

/** Interleaves the speakers' words by start time into turns ("Speaker A: ..."). A turn ends when the speaker changes or after a 1.5 s pause. */
export function mergeTurns(bySpeaker: Record<string, { t: number; w: string }[]>): { speaker: string; text: string }[] {
  const all = Object.entries(bySpeaker).flatMap(([sp, ws]) => ws.map((x) => ({ ...x, sp }))).sort((a, b) => a.t - b.t);
  const turns: { speaker: string; text: string; last: number }[] = [];
  for (const x of all) {
    const cur = turns[turns.length - 1];
    if (cur && cur.speaker === `Speaker ${x.sp}` && x.t - cur.last < 1.5) { cur.text += ` ${x.w}`; cur.last = x.t; }
    else turns.push({ speaker: `Speaker ${x.sp}`, text: x.w, last: x.t });
  }
  return turns.map(({ speaker, text }) => ({ speaker, text }));
}

export function amiFixture(meeting: string, words: Record<string, string>, abssumm: string, date = "2026-01-05"): Fixture {
  const bySpeaker = Object.fromEntries(Object.entries(words).map(([sp, xml]) => [sp, parseWords(xml)]));
  const transcript = mergeTurns(bySpeaker);
  const { decisions, actions } = parseAbssumm(abssumm);
  return {
    id: `ami-${meeting.toLowerCase()}`, title: `AMI ${meeting}`, source: "AMI-style", date, participants: [...new Set(transcript.map((t) => t.speaker))], transcript,
    gold: { decisions: decisions.map((text) => ({ text })), tasks: actions.map((title) => ({ title, owner: null, due: null, label: "confirmed" as const })), duplicates: [], conflicts: [] },
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); }
  return out;
}

/** Reads a local AMI manual-annotation directory. Throws on URLs and missing paths. */
export function loadAmiDir(dir: string, max = Infinity): Fixture[] {
  if (/^[a-z]+:\/\//i.test(dir)) throw new Error("ami loader reads a local directory only; it never downloads anything");
  if (!existsSync(dir)) throw new Error(`not found: ${dir}`);
  const files = walk(dir);
  const abs = files.filter((f) => f.endsWith(".abssumm.xml"));
  const out: Fixture[] = [];
  for (const f of abs) {
    const meeting = f.split("/").pop()!.replace(".abssumm.xml", "");
    const words: Record<string, string> = {};
    for (const w of files) { const m = new RegExp(`/${meeting}\\.([A-Z])\\.words\\.xml$`).exec(w); if (m) words[m[1]!] = readFileSync(w, "utf8"); }
    if (!Object.keys(words).length) continue;
    const fx = amiFixture(meeting, words, readFileSync(f, "utf8"));
    if (fx.gold.tasks.length || fx.gold.decisions.length) out.push(fx);
    if (out.length >= max) break;
  }
  return out;
}

if (import.meta.main) {
  const a = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  const mi = process.argv.indexOf("--max");
  if (!a[0]) { console.error("usage: bun run scripts/meeting-eval-loaders/ami.ts <ami_public_manual dir> [outDir=./gold-local] [--max N]"); process.exit(1); }
  const out = a[1] ?? "./gold-local";
  const fx = loadAmiDir(a[0], mi > 0 ? Number(process.argv[mi + 1]) : Infinity);
  mkdirSync(out, { recursive: true });
  for (const f of fx) writeFileSync(join(out, `${f.id}.json`), `${JSON.stringify(f, null, 1)}\n`);
  console.log(`wrote ${fx.length} AMI fixtures to ${out} (local only: do not commit corpus data)`);
}
