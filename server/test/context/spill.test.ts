import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { db, resetDb } from "../db";
import { toolResults, turns } from "../../src/db/schema";
import { clearOldToolResults, endTurnSpill, minifyToolOutput, readToolResult, spillIfLarge, TURN_RESULT_BUDGET } from "../../src/turn/spill";
import { installFakes, removeFakes } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

describe("spill", () => {
  test("minify drops nulls/empties from JSON and strips HTML", () => {
    expect(minifyToolOutput(JSON.stringify({ a: 1, b: null, c: "", d: [], e: { f: null, g: "x" } }))).toBe('{"a":1,"e":{"g":"x"}}');
    expect(minifyToolOutput("<html><style>p{}</style><body><p>Hello&nbsp;<b>world</b></p></body></html>")).toBe("Hello world");
  });

  test("small results pass through; big ones are stored and returned as preview + handle", async () => {
    await db.insert(turns).values({ id: "T1", channelId: "C1", trigger: "mention" });
    expect(await spillIfLarge({ turnId: "T1", toolName: "x", text: '{"ok":true,"n":null}' })).toBe('{"ok":true}');
    const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, title: `ticket ${i} ${"lorem ".repeat(5)}` })) });
    const out = await spillIfLarge({ turnId: "T1", toolName: "linear_list", text: big });
    expect(out.length).toBeLessThan(1800);
    const handle = /handle:"(tr_[^"]+)"/.exec(out)![1]!;
    expect((await db.select().from(toolResults)).length).toBe(1);
    const page = await readToolResult({ handle, offset: 1500, length: 200, channelId: "C1" });
    expect(page).toContain("of ");
    expect(page.startsWith(minifyToolOutput(big).slice(1500, 1520))).toBe(true);
    // ACL: another channel cannot read it
    expect(await readToolResult({ handle, channelId: "C_OTHER" })).toBe("No stored result with that handle.");
    expect(await readToolResult({ handle: "tr_missing" })).toBe("No stored result with that handle.");
  });

  test("per-turn aggregate budget shrinks later previews", async () => {
    await db.insert(turns).values({ id: "T2", channelId: "C1", trigger: "mention" });
    const chunk = "word ".repeat(500); // 2.5k chars, under the per-call threshold
    let verbatim = 0;
    for (let i = 0; i < 20; i++) {
      const o = await spillIfLarge({ turnId: "T2", toolName: "t", text: `${chunk}${i}` });
      if (!o.includes("[truncated")) verbatim++;
    }
    expect(verbatim * 2500).toBeLessThanOrEqual(TURN_RESULT_BUDGET);
    expect(verbatim).toBeLessThan(20);
    const tail = await spillIfLarge({ turnId: "T2", toolName: "t", text: "z".repeat(5000) });
    expect(tail.length).toBeLessThan(600);
    endTurnSpill("T2");
  });

  test("clearOldToolResults stubs consumed results, keeps the latest, preserves handles", () => {
    const res = (id: string, value: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "search", output: { type: "text", value } }] });
    const msgs: ModelMessage[] = [
      { role: "user", content: "q" },
      res("1", `${"x".repeat(900)}\n[truncated: read_tool_result({handle:"tr_abc123", offset:10})]`),
      res("2", "y".repeat(900)),
      res("3", "z".repeat(900)),
    ];
    const out = clearOldToolResults(msgs);
    const text = (m: ModelMessage) => JSON.stringify(m.content);
    expect(text(out[1]!)).toContain("[cleared search result");
    expect(text(out[1]!)).toContain("tr_abc123");
    expect(text(out[2]!)).toContain("[cleared");
    expect(text(out[3]!)).toContain("zzzz");
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(msgs).length / 2);
    expect(clearOldToolResults(out)).toEqual(out); // idempotent
    expect(msgs[1]).toBe(msgs[1]); // input untouched
  });
});
