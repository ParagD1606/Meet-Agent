import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { captureBuffer, memories, memoryReviews } from "../../src/db/schema";
import { ingestDocument } from "../../src/memory/ingest";
import { setMemoryLlm } from "../../src/memory/llm";
import { addFact } from "../../src/memory/supersede";
import { flushIdleCaptures, pendingCaptureCount, recoverCaptures, scheduleCapture } from "../../src/memory/writeback";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => { await resetDb(); installFakes(); });

const scope = { channelId: "CP1", isPrivate: false, isIm: false, userId: "U1" };
const send = (text: string, threadTs = "1.0") => scheduleCapture({ scope, channelId: "CP1", threadTs, transcript: `${text}\nAssistant: ok`, userText: text, idleMs: 60_000 });
const extractor = () => setMemoryLlm(async (a) => (a.system.includes("extract durable") ? '{"facts":["Dana owns the billing migration project"]}' : '{"superseded":[]}'));

describe("persisted capture buffer", () => {
  test("a buffered thread survives a restart (empty in-memory map) and is flushed on boot", async () => {
    extractor();
    expect((await send("Dana owns the billing migration project now")).deferred).toBe(true);
    const [row] = await db.select().from(captureBuffer);
    expect(row!.chunks).toHaveLength(1);
    // the row, not the in-memory timer index, is the source of truth: boot recovery flushes it
    expect(await recoverCaptures()).toBe(1);
    expect(await db.select().from(captureBuffer)).toHaveLength(0);
    expect((await db.select().from(memories)).map((m) => m.text)).toEqual(["Dana owns the billing migration project"]);
    expect(pendingCaptureCount()).toBe(0);
  });

  test("chunks accumulate across turns in one row; the idle sweep respects the idle window", async () => {
    extractor();
    await send("Dana owns the billing migration project now");
    await send("and the deadline for it is in May this year");
    const [row] = await db.select().from(captureBuffer);
    expect(row!.chunks).toHaveLength(2);
    expect(await flushIdleCaptures(60_000)).toBe(0);
    expect(await db.select().from(captureBuffer)).toHaveLength(1);
    expect(await flushIdleCaptures(0)).toBe(1);
  });

  test("a failed extraction keeps the transcript for retry (max 3 attempts), then gives up", async () => {
    setMemoryLlm(async () => { throw new Error("llm down"); });
    await send("Dana owns the billing migration project now");
    expect(await flushIdleCaptures(0)).toBe(0);
    expect((await db.select().from(captureBuffer))[0]!.attempts).toBe(1);
    await flushIdleCaptures(0);
    expect((await db.select().from(captureBuffer))[0]!.attempts).toBe(2);
    extractor(); // LLM is back
    expect(await flushIdleCaptures(0)).toBe(1);
    expect(await db.select().from(captureBuffer)).toHaveLength(0);
    setMemoryLlm(async () => { throw new Error("llm down"); });
    await send("Another durable fact lands here", "2.0");
    for (let i = 0; i < 4; i++) await flushIdleCaptures(0);
    expect(await db.select().from(captureBuffer)).toHaveLength(0); // dropped after the third failure
  });
});

describe("document chunks: light contradiction check", () => {
  const doc = (text: string, tag = "shared") => ingestDocument({ tag, name: "policy.txt", mimeType: "text/plain", data: text, source: "upload", sourceRef: "policy.txt" });

  test("a chunk contradicting a live shared fact queues a doc_conflict review and does not touch the fact", async () => {
    const f = await addFact({ tag: "shared", text: "Refund approvals above 500 dollars need the finance lead", source: "t" });
    setMemoryLlm(async (a) => (a.prompt.includes("NEW:") ? `{"superseded":[${f.id}]}` : "{}"));
    expect(await doc("Refund approvals above 500 dollars need the finance lead and now also the CEO.")).toBe(1);
    const [rv] = await db.select().from(memoryReviews);
    expect(rv).toMatchObject({ kind: "doc_conflict", status: "pending" });
    expect((rv!.payload as { conflictsWithFactIds: number[] }).conflictsWithFactIds).toEqual([f.id]);
    expect((await db.select().from(memories)).find((m) => m.id === f.id)!.status).toBe("active");
  });

  test("no review when there is no conflict, for unchanged re-syncs, on LLM failure, or for private scopes", async () => {
    const f = await addFact({ tag: "shared", text: "Refund approvals above 500 dollars need the finance lead", source: "t" });
    setMemoryLlm(async () => '{"superseded":[]}');
    await doc("Refund approvals above 500 dollars need the finance lead as written.");
    expect(await db.select().from(memoryReviews)).toHaveLength(0);
    setMemoryLlm(async () => { throw new Error("down"); });
    expect(await doc("Refund approvals above 500 dollars need the finance lead as amended.")).toBe(1); // ingest still succeeds
    expect(await db.select().from(memoryReviews)).toHaveLength(0);
    let calls = 0;
    setMemoryLlm(async () => { calls++; return `{"superseded":[${f.id}]}`; });
    await doc("Refund approvals above 500 dollars need the finance lead as amended.");
    expect(calls).toBe(0); // unchanged chunk: not re-checked
    await addFact({ tag: "user_U1", text: "My refund approvals above 500 dollars note", source: "t" });
    await doc("Refund approvals above 500 dollars note differs completely.", "user_U1");
    expect(calls).toBe(0); // private scope never reaches the admin review queue
  });
});
