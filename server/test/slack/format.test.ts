import { describe, expect, test } from "bun:test";
import { chunkText, toMrkdwn } from "../../src/slack/format";

describe("toMrkdwn", () => {
  test("bold, headings, links, bullets", () => {
    expect(toMrkdwn("# Title\n**bold** and [site](https://a.io/x)\n- item")).toBe("*Title*\n*bold* and <https://a.io/x|site>\n• item");
  });
  test("escapes HTML-ish chars but keeps slack tokens and code verbatim", () => {
    expect(toMrkdwn("a < b & <@U1> `x<y`")).toBe("a &lt; b &amp; <@U1> `x&lt;y`");
    expect(toMrkdwn("```ts\nconst a = 1 < 2;\n```")).toBe("```\nconst a = 1 &lt; 2;\n```");
  });
  test("markdown inside code is untouched", () => {
    expect(toMrkdwn("`**not bold**`")).toBe("`**not bold**`");
  });
});

describe("chunkText", () => {
  test("short text is a single chunk", () => expect(chunkText("hi", 10)).toEqual(["hi"]));
  test("no chunk exceeds the limit (plus fence slack) and content is preserved", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} lorem ipsum`).join("\n");
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
  test("code fences stay balanced across chunks", () => {
    const text = "```\n" + Array.from({ length: 40 }, (_, i) => `code ${i}`).join("\n") + "\n```";
    for (const c of chunkText(text, 80)) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
  });
});
