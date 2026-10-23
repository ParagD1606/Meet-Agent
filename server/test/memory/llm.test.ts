import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { cachedSystem, estimateCostMicros, getFallbackModel, isRetriableModelError, setModelChoicesForTest, setModelResolverForTest, withFallback } from "../../src/llm";
import { completeJson, parseModelJson, setMemoryLlm } from "../../src/memory/llm";

afterEach(() => { setMemoryLlm(null); setModelResolverForTest(undefined); setModelChoicesForTest({ fallback: null }); });

const facts = z.object({ facts: z.array(z.string()) });

describe("completeJson repairs near-valid model output", () => {
  test.each([
    ['{"facts":["Dana owns billing"]', ["Dana owns billing"]], // missing closing brace
    ['{"facts":["a","b",', ["a", "b"]], // truncated mid-array
    ['Sure! Here you go:\n```json\n{"facts":["x y z"]\n```', ["x y z"]],
    ['{"facts":["uses {braces} inline"]', ["uses {braces} inline"]],
    ['{"facts":["ok"]}\n\nHope that helps }', ["ok"]],
    ["{'facts': ['single quotes']}", ["single quotes"]],
  ])("%s", async (raw, expected) => {
    expect(parseModelJson(raw, facts).facts).toEqual(expected);
    setMemoryLlm(async () => raw);
    expect((await completeJson({ system: "", prompt: "" }, facts)).facts).toEqual(expected);
  });
  test("still throws when there is no object or the shape is wrong", async () => {
    setMemoryLlm(async () => "no json at all");
    await expect(completeJson({ system: "", prompt: "" }, facts)).rejects.toThrow();
    setMemoryLlm(async () => '{"other":1}');
    await expect(completeJson({ system: "", prompt: "" }, facts)).rejects.toThrow();
  });
});

describe("model roles, fallback, cost, caching", () => {
  test("withFallback retries a retriable failure on the fallback model only", async () => {
    setModelResolverForTest((_r, fb) => ({ modelId: fb ? "fallback-model" : "primary-model" }) as never);
    const seen: string[] = [];
    const out = await withFallback("main", async (m) => {
      seen.push((m as { modelId: string }).modelId);
      if (seen.length === 1) throw Object.assign(new Error("overloaded"), { statusCode: 529 });
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen).toEqual(["primary-model", "fallback-model"]);
    // 4xx request errors and aborts are not retried
    seen.length = 0;
    await expect(withFallback("main", async (m) => { seen.push((m as { modelId: string }).modelId); throw Object.assign(new Error("bad"), { statusCode: 400 }); })).rejects.toThrow("bad");
    expect(seen).toEqual(["primary-model"]);
    expect(isRetriableModelError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isRetriableModelError(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(true);
  });

  test("no fallback configured -> original error; fallback spec parsing needs a key", () => {
    setModelChoicesForTest({ fallback: "openai:gpt-4.1-mini" });
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY; delete process.env.FALLBACK_MODEL_API_KEY;
    expect(getFallbackModel()).toBeNull();
    process.env.OPENAI_API_KEY = "sk-test";
    expect((getFallbackModel() as { modelId?: string }).modelId).toBe("gpt-4.1-mini");
    if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
  });

  test("cost table: cache reads are cheaper, unknown/local models are free", () => {
    const plain = estimateCostMicros("claude-sonnet-4-5", { inputTokens: 1000, outputTokens: 100 });
    expect(plain).toBe(1000 * 3 + 100 * 15);
    const cached = estimateCostMicros("claude-sonnet-4-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 });
    expect(cached).toBeLessThan(plain);
    expect(estimateCostMicros("llama3.2:3b", { inputTokens: 5000, outputTokens: 500 })).toBe(0);
  });

  test("cachedSystem marks cache breakpoints (max 4) and drops empty blocks", () => {
    const m = cachedSystem([{ text: "static", cache: true }, { text: "" }, { text: "company" }, { text: "user", cache: true }]);
    expect(m.map((x) => x.content)).toEqual(["static", "company", "user"]);
    expect(m[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(m[1]!.providerOptions).toBeUndefined();
    expect(m[2]!.providerOptions).toBeDefined();
  });
});
