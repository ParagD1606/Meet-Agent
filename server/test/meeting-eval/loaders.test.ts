// Loaders run on tiny hand-made samples only (offline: no corpus is shipped and nothing is fetched).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amiFixture, loadAmiDir, mergeTurns, parseAbssumm, parseWords } from "../../scripts/meeting-eval-loaders/ami";
import { loadQmsumDir, qmsumFixture } from "../../scripts/meeting-eval-loaders/qmsum";
import { validateFixture } from "./lib";

const wordsA = `<?xml version="1.0"?><nite:root xmlns:nite="http://nite.sourceforge.net/"><w nite:id="a.1" starttime="1.0" endtime="1.2">I'll</w><w nite:id="a.2" starttime="1.2" endtime="1.5">send</w><w nite:id="a.3" starttime="1.5" endtime="1.8">the</w><w nite:id="a.4" starttime="1.8" endtime="2.1">minutes</w><w nite:id="a.5" starttime="2.1" endtime="2.1" punc="true">.</w></nite:root>`;
const wordsB = `<nite:root><w starttime="3.0" endtime="3.2">Okay</w><w starttime="3.2" endtime="3.5">thanks</w><w starttime="9.0" endtime="9.4">Bye</w></nite:root>`;
const abs = `<nite:root><abstract><sentence nite:id="x.1">The team kicked off.</sentence></abstract><decisions><sentence nite:id="x.2">The remote will be &quot;single device&quot;.</sentence></decisions><actions><sentence nite:id="x.3">Project manager to send the minutes.</sentence><sentence nite:id="x.4">Designer to draft <nite:pointer href="y"/>a sketch.</sentence></actions></nite:root>`;

describe("AMI loader", () => {
  test("parses words (punctuation glued), sentences (entities and inner tags stripped) and interleaves turns", () => {
    expect(parseWords(wordsA).map((w) => w.w).join(" ")).toBe("I'll send the minutes.");
    expect(parseAbssumm(abs)).toEqual({ decisions: ['The remote will be "single device".'], actions: ["Project manager to send the minutes.", "Designer to draft a sketch."] });
    const turns = mergeTurns({ A: parseWords(wordsA), B: parseWords(wordsB) });
    expect(turns).toEqual([{ speaker: "Speaker A", text: "I'll send the minutes." }, { speaker: "Speaker B", text: "Okay thanks" }, { speaker: "Speaker B", text: "Bye" }]);
  });
  test("builds a valid fixture and reads a local directory; URLs are refused", () => {
    const fx = amiFixture("ES0000a", { A: wordsA, B: wordsB }, abs);
    expect(validateFixture(fx)).toEqual([]);
    expect(fx.gold.tasks.map((t) => t.title)).toHaveLength(2);
    const d = mkdtempSync(join(tmpdir(), "ami-"));
    mkdirSync(join(d, "words")); mkdirSync(join(d, "abstractive"));
    writeFileSync(join(d, "words/ES0000a.A.words.xml"), wordsA); writeFileSync(join(d, "words/ES0000a.B.words.xml"), wordsB);
    writeFileSync(join(d, "abstractive/ES0000a.abssumm.xml"), abs);
    const loaded = loadAmiDir(d);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("ami-es0000a");
    expect(() => loadAmiDir("https://groups.inf.ed.ac.uk/ami/")).toThrow(/local directory/);
    expect(() => loadAmiDir(join(d, "nope"))).toThrow(/not found/);
  });
});

const qm = {
  meeting_transcripts: [{ speaker: "Project Manager", content: "We will go with the cheaper case." }, { speaker: "Designer", content: "I will send the sketch." }],
  general_query_list: [{ query: "What did the group decide about the case?", answer: "They decided on the cheaper case." }],
  specific_query_list: [{ query: "What action items were assigned to the designer?", answer: "The designer will send the sketch." }, { query: "What was said about lunch?", answer: "Nothing." }],
};

describe("QMSum loader", () => {
  test("decision queries become gold decisions, action queries gold tasks, others ignored", () => {
    const fx = qmsumFixture("Bed003", qm);
    expect(validateFixture(fx)).toEqual([]);
    expect(fx.gold.decisions).toEqual([{ text: "They decided on the cheaper case." }]);
    expect(fx.gold.tasks.map((t) => t.title)).toEqual(["The designer will send the sketch."]);
    expect(fx.id).toBe("qmsum-bed003");
  });
  test("reads a local directory recursively; refuses URLs", () => {
    const d = mkdtempSync(join(tmpdir(), "qm-"));
    mkdirSync(join(d, "train"));
    writeFileSync(join(d, "train/Bed003.json"), JSON.stringify(qm));
    writeFileSync(join(d, "train/notes.json"), JSON.stringify({ other: 1 }));
    expect(loadQmsumDir(d)).toHaveLength(1);
    expect(() => loadQmsumDir("http://example.com/qmsum")).toThrow(/local directory/);
  });
});
