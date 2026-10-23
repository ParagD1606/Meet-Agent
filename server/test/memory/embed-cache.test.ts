import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { embed, embedStats, setEmbedder } from "../../src/memory/embed";
import { ingestDocument } from "../../src/memory/ingest";
import { fakeVector } from "./helpers";

let calls: string[][] = [];
beforeAll(() => setEmbedder(async (t) => { calls.push(t); return t.map(fakeVector); }, { useCache: true }));
afterAll(() => setEmbedder(null));
beforeEach(async () => { await resetDb(); calls = []; embedStats.hits = embedStats.misses = embedStats.calls = 0; });

describe("embedding cache", () => {
  test("identical content hits the cache; duplicates within a call are embedded once", async () => {
    const a = await embed(["alpha one", "beta two", "alpha one"]);
    expect(calls).toEqual([["alpha one", "beta two"]]);
    expect(a[0]).toEqual(a[2]);
    const b = await embed(["beta two", "gamma three"]);
    expect(calls[1]).toEqual(["gamma three"]);
    expect(b[0]!.every((x, i) => Math.abs(x - a[1]![i]!) < 1e-6)).toBe(true); // pgvector stores float32
    await embed(["alpha one", "gamma three"]);
    expect(calls.length).toBe(2);
    expect(embedStats.hits).toBeGreaterThanOrEqual(4);
  });

  test("re-ingesting an unchanged document makes no embedding call", async () => {
    const text = "Paragraph about pricing.\n\n".repeat(5) + "Another section on onboarding steps.";
    await ingestDocument({ tag: "shared", name: "a.md", mimeType: "text/markdown", data: text, source: "upload", sourceRef: "a.md" });
    const n = calls.length;
    await ingestDocument({ tag: "shared", name: "a.md", mimeType: "text/markdown", data: text, source: "upload", sourceRef: "a.md" });
    expect(calls.length).toBe(n);
  });
});
