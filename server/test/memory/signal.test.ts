import "../turn/env";
import { describe, expect, test } from "bun:test";
import { cutSentence, renderHit } from "../../src/memory/recall";
import type { MemoryHit } from "../../src/memory/search";
import { classify, contentStems, coverage, namedTokens, sharedWords, type SignalFeatures } from "../../src/memory/signal";

const F = (o: Partial<SignalFeatures> = {}): SignalFeatures => ({ topRank: 0.9, gap: 2, aboveMin: 5, count: 4, lexical: true, shared: 3, maxCos: 0.8, named: 1, covered: 1, ...o });

describe("retrieval-confidence signal (classify)", () => {
  test("strong: keyword/entity-supported, high rank, all named things known", () => {
    expect(classify(F()).level).toBe("strong");
    expect(classify(F({ lexical: false, shared: 3, covered: 1, topRank: 0.5 })).level).toBe("strong"); // paraphrase with entity support
    expect(classify(F({ lexical: false, shared: 0, covered: 0, named: 0, maxCos: 0.8 }))).toMatchObject({ level: "strong", reason: "semantic" }); // pure paraphrase, very close
  });

  test("weak: supported but thin, or only part of the named things are known", () => {
    expect(classify(F({ topRank: 0.2, gap: 1, maxCos: 0.4, named: 0, covered: 0 }))).toMatchObject({ level: "weak", reason: "thin" });
    expect(classify(F({ named: 2, covered: 1 }))).toMatchObject({ level: "weak", reason: "partial_entity" });
    expect(classify(F({ lexical: false, shared: 1, covered: 0, named: 0, maxCos: 0.7 })).level).toBe("weak"); // vector only, mid cosine
  });

  test("none: no hits, unknown entity, or no support at all", () => {
    expect(classify(F({ count: 0 }))).toMatchObject({ level: "none", reason: "no_hits" });
    expect(classify(F({ named: 1, covered: 0 }))).toMatchObject({ level: "none", reason: "unknown_entity" }); // Berlin is named, nothing recalled mentions Berlin
    expect(classify(F({ lexical: false, shared: 1, named: 0, covered: 0, maxCos: 0.5 }))).toMatchObject({ level: "none", reason: "no_support" });
  });

  test("a high-cosine distractor cannot rescue an unknown entity", () => {
    expect(classify(F({ named: 1, covered: 0, maxCos: 0.79, lexical: false, shared: 3 })).level).toBe("none"); // real embeddings put near-miss facts at 0.7-0.8
  });
});

describe("question entities and coverage", () => {
  test("namedTokens keeps names and ids, drops acronyms, dates, tools and the sentence-initial word", () => {
    expect(namedTokens("Which city is our Berlin office in?")).toEqual(["Berlin"]);
    expect(namedTokens("What is the CEO's plan for Friday and March?")).toEqual([]);
    expect(namedTokens("What happened in SUP-4412 for Initech on Slack?")).toEqual(["SUP-4412", "Initech"]);
  });

  test("coverage matches words in hit text or entity aliases, tolerating a one-letter typo", () => {
    expect(coverage(["Berlin"], ["The Lisbon office lease renews in March"])).toBe(0);
    expect(coverage(["Dana"], ["Billing is owned by D. Schmidt", "dana schmidt"])).toBe(1); // alias
    expect(coverage(["Quigly"], ["Bartholomew Quigley owns the ledger"])).toBe(1);
    expect(coverage(["Kepler", "Boreas"], ["The Kepler contract renews"])).toBe(1);
  });

  test("sharedWords counts stemmed content words, not stopwords", () => {
    expect(sharedWords(contentStems("Which vendor supplies office coffee?"), "The vendor for office coffee is Bluebird")).toBe(3);
    expect(sharedWords(contentStems("What is the plan?"), "the plan is on the board")).toBe(1);
  });
});

describe("hit rendering", () => {
  const hit = (o: Partial<MemoryHit> = {}): MemoryHit => ({
    id: 1, text: "Dana owns billing.", scopeTag: "channel_C1", source: "slack", sourceRef: null, score: 1, createdAt: new Date("2026-03-04"), kind: "fact", importance: 0.5,
    confidence: 1, accessCount: 0, validAt: new Date("2026-03-01"), validUntil: null, factType: "fact", lastAccessedAt: null, createdBy: null, permalink: null, ...o,
  });

  test("adds channel, learned-at date and entity names", () => {
    expect(renderHit(hit({ channel: "eng", entities: ["Dana Schmidt", "Billing"] }))).toBe("- Dana owns billing. (slack #eng, 2026-03-01; learned 2026-03-04; about Dana Schmidt, Billing)");
    expect(renderHit(hit({ createdAt: new Date("2026-03-01") }))).toBe("- Dana owns billing. (slack, 2026-03-01)");
  });

  test("cuts long text at a sentence boundary, never mid-word", () => {
    const s = `${"First sentence is complete. ".repeat(30)}Tail`;
    const cut = cutSentence(s, 700);
    expect(cut.length).toBeLessThanOrEqual(705);
    expect(cut).toMatch(/complete\. \.\.\.$/);
    expect(cutSentence("word ".repeat(300), 700)).toMatch(/ word\.\.\.$/); // no sentence end: last space, not mid-word
    expect(cutSentence("word ".repeat(300), 700).length).toBeLessThanOrEqual(703);
    expect(cutSentence("short", 700)).toBe("short");
  });
});
