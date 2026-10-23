import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { memories } from "../../src/db/schema";
import { addFact } from "../../src/memory/supersede";
import { setMemoryLlm } from "../../src/memory/llm";
import { buildRecall, clearRecallCache } from "../../src/memory/recall";
import { db, resetDb } from "../api/helpers";
import { installFakes } from "./helpers";

const pub = { channelId: "CPUB", isPrivate: false, isIm: false, userId: "U1" };

describe("dedupe vs review_state, recall cache invalidation", () => {
  beforeEach(async () => { await resetDb(); installFakes(); clearRecallCache(); });
  test("an identical live fact still dedupes", async () => {
    const a = await addFact({ tag: "shared", text: "Dana owns billing", source: "t" });
    expect((await addFact({ tag: "shared", text: "Dana owns billing", source: "t" })).id).toBe(a.id);
  });
  test("repeated non-primary writes of the same text keep one pending row", async () => {
    const a = await addFact({ tag: "shared", text: "Research: launch is May", source: "t", agentContext: "research" });
    const b = await addFact({ tag: "shared", text: "Research: launch is May", source: "t", agentContext: "research" });
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    expect(await db.select().from(memories)).toHaveLength(1);
  });
  test("a new fact is recalled immediately despite a cached empty result", async () => {
    const q = { scope: pub, query: "who owns the billing migration project", threadKey: "T9" };
    expect((await buildRecall(q)).text).toBe("");
    await addFact({ tag: "shared", text: "Dana owns the billing migration project", source: "t" });
    expect((await buildRecall(q)).text).toContain("Dana owns");
  });
  test("superseding a fact drops it from a cached recall", async () => {
    await addFact({ tag: "shared", text: "Dana owns the billing migration project", source: "t" });
    const q = { scope: pub, query: "who owns the billing migration project", threadKey: "T10" };
    expect((await buildRecall(q)).text).toContain("Dana owns");
    setMemoryLlm(async () => '{"superseded":[1]}');
    await addFact({ tag: "shared", text: "Priya now owns the billing migration project", source: "t" });
    installFakes();
    const t = (await buildRecall(q)).text;
    expect(t).not.toContain("Dana owns");
  });
});
