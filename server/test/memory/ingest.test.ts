import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, memoryEdges } from "../../src/db/schema";
import { chunkText, htmlToText, ingestDocument } from "../../src/memory/ingest";
import { searchMemory } from "../../src/memory/search";
import { installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

const rows = () => db.select().from(memories).orderBy(asc(memories.id));

describe("chunkText", () => {
  test("short text is one chunk; long text overlaps and covers everything", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    const para = "Sentence about onboarding. ".repeat(20).trim();
    const text = Array.from({ length: 30 }, (_, i) => `P${i} ${para}`).join("\n\n");
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks[0]).toContain("P0");
    expect(chunks.at(-1)).toContain("P29");
    // overlap: each chunk starts with text that also ends the previous one
    for (let i = 1; i < chunks.length; i++) expect(chunks[i - 1]!.includes(chunks[i]!.slice(0, 20))).toBe(true);
  });

  test("text with no whitespace is hard-cut and terminates", () => {
    const chunks = chunkText("x".repeat(5000), 1000, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.join("").length).toBeGreaterThanOrEqual(5000);
  });
});

describe("ingestDocument", () => {
  test("stores chunk rows in the given tag and they are searchable", async () => {
    const body = `# Vacation policy\n\nEmployees get 25 days of vacation.\n\n${"Filler paragraph about other things. ".repeat(200)}`;
    const n = await ingestDocument({ tag: "shared", name: "handbook.md", mimeType: "text/markdown", data: body, source: "upload", sourceRef: "f1" });
    const stored = await rows();
    expect(n).toBe(stored.length);
    expect(n).toBeGreaterThan(1);
    expect(stored.every((r) => r.kind === "chunk" && r.scopeTag === "shared" && r.sourceRef === "f1" && r.text.startsWith("From handbook.md:"))).toBe(true);
    const hits = await searchMemory({ tags: ["shared"], query: "vacation days policy" });
    expect(hits[0]!.text).toContain("25 days");
  });

  test("re-ingesting the same (source, sourceRef) replaces chunks; other docs and facts are untouched", async () => {
    await seedMemory("shared", "a fact");
    await ingestDocument({ tag: "shared", name: "other.txt", mimeType: "text/plain", data: "other doc", source: "upload", sourceRef: "f2" });
    await ingestDocument({ tag: "shared", name: "a.txt", mimeType: "text/plain", data: "version one", source: "upload", sourceRef: "f1" });
    const old = (await rows()).find((r) => r.text.includes("version one"))!;
    await db.insert(memoryEdges).values({ fromId: old.id, toId: old.id });
    await ingestDocument({ tag: "shared", name: "a.txt", mimeType: "text/plain", data: "version two", source: "upload", sourceRef: "f1" });
    const texts = (await rows()).map((r) => r.text);
    expect(texts.some((t) => t.includes("version one"))).toBe(false);
    expect(texts.filter((t) => t.includes("version two")).length).toBe(1);
    expect(texts.some((t) => t.includes("other doc"))).toBe(true);
    expect(texts).toContain("a fact");
    expect((await db.select().from(memoryEdges)).length).toBe(0);
    // same sourceRef under a different source is a different document
    await ingestDocument({ tag: "shared", name: "n.txt", mimeType: "text/plain", data: "notion page", source: "notion", sourceRef: "f1" });
    expect((await rows()).some((r) => r.text.includes("version two"))).toBe(true);
  });

  test("html and csv are extracted; empty content stores nothing and still clears old chunks", async () => {
    await ingestDocument({
      tag: "user_U1", name: "p.html", mimeType: "text/html", source: "upload", sourceRef: "h",
      data: "<html><head><style>x{}</style></head><body><script>alert(1)</script><h1>Title&amp;Co</h1><p>Hello&nbsp;world</p></body></html>",
    });
    const [h] = await rows();
    expect(h!.text).toContain("Title&Co");
    expect(h!.text).toContain("Hello world");
    expect(h!.text).not.toContain("alert");
    expect(htmlToText("<p>a</p><p>b &#65; &#x42;</p>")).toContain("b A B");

    await ingestDocument({ tag: "shared", name: "t.csv", mimeType: "text/csv", data: Buffer.from("name,role\nAda,CTO\n"), source: "upload", sourceRef: "c" });
    expect((await rows()).some((r) => r.text.includes("Ada,CTO"))).toBe(true);

    expect(await ingestDocument({ tag: "user_U1", name: "p.html", mimeType: "text/html", data: "   ", source: "upload", sourceRef: "h" })).toBe(0);
    expect((await rows()).some((r) => r.sourceRef === "h")).toBe(false);
  });

  test("pdf text is extracted", async () => {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      "STREAM",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const content = "BT /F1 14 Tf 10 50 Td (Zebra migration plan) Tj ET";
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o === "STREAM" ? `<< /Length ${content.length} >>\nstream\n${content}\nendstream` : o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const n = await ingestDocument({ tag: "shared", name: "plan.pdf", mimeType: "application/pdf", data: Buffer.from(pdf, "latin1"), source: "upload" });
    expect(n).toBe(1);
    expect((await rows())[0]!.text).toContain("Zebra migration plan");
  });

  test("unsupported types fail clearly and write nothing", async () => {
    await expect(ingestDocument({ tag: "shared", name: "x.png", mimeType: "image/png", data: Buffer.from([1, 2]), source: "upload" })).rejects.toThrow(/Unsupported/);
    expect((await db.select().from(memories).where(eq(memories.kind, "chunk"))).length).toBe(0);
  });
});
