import "../turn/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { episodes } from "../../src/db/schema";
import { setMemoryLlm } from "../../src/memory/llm";
import { EXTRACT_SYSTEM, flushIdleCaptures, scheduleCapture } from "../../src/memory/writeback";
import { heuristicDepth } from "../../src/turn/depth";
import { db, resetDb } from "../api/helpers";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
const pub = { channelId: "CPUB", isPrivate: false, isIm: false, userId: "U1" };

describe("short thread flushed by idle sweep", () => {
  beforeEach(async () => { await resetDb(); installFakes(); });
  test("makes exactly one episode; re-flushing does not duplicate", async () => {
    setMemoryLlm(async (a) => (a.system === EXTRACT_SYSTEM ? '{"facts":["Dana owns the billing migration project"]}'
      : a.system.startsWith("Summarise") ? "Dana was named owner of the billing migration and the cutover happens in March." : '{"superseded":[]}'));
    const send = () => scheduleCapture({ scope: pub, channelId: "CPUB", threadTs: "9.1", transcript: "Dana owns the billing migration project, cutover in March\nAssistant: noted ".repeat(4), userText: "Dana owns the billing migration project", idleMs: 60_000 });
    await send(); await flushIdleCaptures(0);
    await send(); await flushIdleCaptures(0);
    expect(await db.select().from(episodes)).toHaveLength(1);
  });
});

describe("depth routing for memory writes", () => {
  const d = (text: string, hasHistory = false) => heuristicDepth({ trigger: "mention", text, hasHistory });
  test("corrections and save requests get tools; questions stay memory; greetings stay direct", () => {
    expect(d("actually the owner is Dana", true)).toBe("tools");
    expect(d("that's wrong, it was March", true)).toBe("tools");
    expect(d("please remember that the owner is Dana")).toBe("tools");
    expect(d("actually the owner is Dana", false)).not.toBe("tools");
    expect(d("Who owns billing?")).toBe("memory");
    expect(d("hello")).toBe("direct");
  });
});
