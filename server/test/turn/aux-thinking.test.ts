// 0d: every auxiliary LLM call asks Gemini 3.x for minimal thinking, so hidden reasoning cannot eat the small output caps.
import "./env";
import { afterEach, describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { setModelResolverForTest } from "../../src/llm";
import { completeJson, completeText, setMemoryLlm } from "../../src/memory/llm";
import { rewriteQuery } from "../../src/memory/rewrite";
import { triageDetailed } from "../../src/slack/triage";
import { routeDepth, setDepthClassifier } from "../../src/turn/depth";
import { classifySteer, setSteerClassifier } from "../../src/turn/steering";

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const MIN = { vertex: { thinkingConfig: { thinkingLevel: "minimal" } }, google: { thinkingConfig: { thinkingLevel: "minimal" } } };

/** Simulates Gemini 3.x: without minimal thinking the reasoning eats the cap and the visible text comes back empty. */
function gemini(reply: string) {
  const model = new MockLanguageModelV4({
    doGenerate: async (o: any) => {
      const thinks = o.providerOptions?.google?.thinkingConfig?.thinkingLevel !== "minimal";
      return { content: [{ type: "text", text: thinks ? "" : reply }], finishReason: { unified: thinks ? "length" : "stop", raw: "x" }, usage, warnings: [] } as any;
    },
  });
  setModelResolverForTest(() => model as never);
  return model;
}
afterEach(() => { setModelResolverForTest(undefined); setMemoryLlm(null); setDepthClassifier(); setSteerClassifier(); });

describe("auxiliary calls carry thinking=minimal", () => {
  test("completeText / completeJson (all memory callers) send both provider keys, and an override wins", async () => {
    const m = gemini('{"ok":true}');
    expect(await completeText({ system: "s", prompt: "p" })).toBe('{"ok":true}');
    expect(await completeJson({ system: "s", prompt: "p" }, z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(m.doGenerateCalls.every((c) => JSON.stringify(c.providerOptions) === JSON.stringify(MIN))).toBe(true);
    await completeText({ system: "s", prompt: "p", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } });
    expect((m.doGenerateCalls.at(-1)!.providerOptions as any).google.thinkingConfig.thinkingLevel).toBe("high");
  });

  test("depth classifier: non-empty answer even when thinking would have truncated it", async () => {
    const m = gemini("tools");
    const r = await routeDepth({ trigger: "mention", text: "and the second one", hasFiles: false, hasHistory: true, readOnly: false });
    expect(r).toEqual({ depth: "tools", by: "model" });
    expect(m.doGenerateCalls[0]!.providerOptions).toEqual(MIN as never);
    expect(m.doGenerateCalls[0]!.maxOutputTokens).toBeGreaterThanOrEqual(32);
  });

  test("steering classifier", async () => {
    const m = gemini("REPLACE");
    expect(await classifySteer("summarize Titan", { text: "Actually forget that, who owns the checklist?" })).toBe("REPLACE");
    expect(m.doGenerateCalls[0]!.providerOptions).toEqual(MIN as never);
    expect(m.doGenerateCalls[0]!.maxOutputTokens).toBeGreaterThanOrEqual(32);
  });

  test("triage", async () => {
    const m = gemini("PASS\nReason: chit-chat");
    const r = await triageDetailed({ text: "lunch anyone?", context: "channel" } as never);
    expect(r.decision).toBe("PASS");
    expect(r.source).toBe("model");
    expect(m.doGenerateCalls[0]!.providerOptions).toEqual(MIN as never);
  });

  test("query rewrite (through completeJson)", async () => {
    const m = gemini('{"query":"pricing decision","asOf":null}');
    const r = await rewriteQuery({ query: "what about that?", threadTail: ["user: we changed pricing"] });
    expect(r.query).toBe("pricing decision");
    expect(m.doGenerateCalls[0]!.providerOptions).toEqual(MIN as never);
  });
});
