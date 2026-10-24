// 0e: small correctness fixes in the turn pipeline.
import "../slack/env";
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { channels } from "../../src/db/schema";
import { setMemoryLlm } from "../../src/memory/llm";
import { EXTRACT_SYSTEM } from "../../src/memory/writeback";
import { setDepthClassifier } from "../../src/turn/depth";
import { spillTracked } from "../../src/turn/spill";
import { PUB, boot, eventually, mention, nextTs, scriptModel, seedMessage, scriptedTest, send, teardown } from "./harness";

beforeEach(async () => { await boot(); setDepthClassifier(async () => "tools"); });
afterAll(teardown);

describe("turn hygiene", () => {
  scriptedTest("the per-turn spill total is released when a tool turn ends (no Map entry leaked per turn)", async () => {
    scriptModel((s) => (s.called("find_tasks") ? { text: "No tasks." } : { call: "find_tasks", input: {} }));
    await send(mention("assign check my tasks please"));
    expect(spillTracked()).toBe(0);
  });

  scriptedTest("compaction runs pre-compaction fact capture (scope is passed)", async () => {
    await db.update(channels).set({ observe: false }).where(eq(channels.id, PUB)); // no ambient extraction: only compaction can see the old messages
    const extracted: string[] = [];
    setMemoryLlm(async (a) => {
      if (a.system === EXTRACT_SYSTEM) { extracted.push(a.prompt); return '{"facts":[]}'; }
      if (a.system.includes("handoff summaries")) return "## Active Task\nNone.\n\n## Goal\nTalk about the launch plan in detail for the team.\n";
      return '{"superseded":[],"facts":[],"commitments":[]}';
    });
    const root = nextTs();
    for (let n = 0; n < 24; n++) seedMessage(PUB, n === 0 ? root : nextTs(), root, "UDANA", `MARKER-OLD ${n} ${"the launch plan needs a decision on pricing and rollout. ".repeat(18)}`);
    scriptModel(() => ({ text: "Noted, the plan is in progress." }));
    await send(mention("what is the status of the launch plan?", { thread_ts: root }));
    await eventually(() => extracted.some((p) => p.includes("MARKER-OLD")));
  });
});
