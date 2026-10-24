import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { commitments, meetings, users } from "../../src/db/schema";
import { insertCommitment } from "../../src/manager/commitments";
import { analyzeLiveMeeting, createUploadedMeeting, getMeeting, UploadError } from "../../src/meetings";
import { CHUNK_CHARS, SINGLE_PASS_CHARS } from "../../src/meetings/analyze";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { app, call, db, login, resetDb } from "../api/helpers";
import { fakeVector, seedChannel } from "../memory/helpers";
import { fakeSlack } from "../slack/helpers";

let me: string, other: string;
let reply: (a: { system: string; prompt: string }) => string;
let calls: { system: string; prompt: string }[];
const t = (o: Record<string, unknown>) => ({ description: "", assigneeName: null, assigneeId: null, dueDate: null, kind: "commitment", label: "confirmed", confidence: 0.9, priority: "normal", followUp: false, reason: "", evidence: [], ...o });
const ok = (tasks: unknown[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({ summary: "## Discussion\n- talked", decisions: [], questions: [], tasks, ...extra });

beforeEach(async () => {
  await resetDb();
  setEmbedder(async (x) => x.map(fakeVector));
  setSlackClientForTest(fakeSlack().client);
  me = await login("U_ME", "member");
  other = await login("U_OTHER", "member");
  await db.update(users).set({ name: "Parag" }).where(eq(users.id, "U_OTHER"));
  await db.update(users).set({ name: "Dana" }).where(eq(users.id, "U_ME"));
  await seedChannel("CPUB", { members: ["U_ME"] });
  await seedChannel("CPRIV", { isPrivate: true, members: ["U_ME"] });
  calls = [];
  reply = () => ok();
  setMemoryLlm(async (a) => { if (a.system.includes("meeting source material") || a.system.startsWith("Combine these partial")) { calls.push(a); return reply(a); } return '{"facts":[],"superseded":[]}'; });
});
afterEach(() => { setMemoryLlm(null); setEmbedder(null); setSlackClientForTest(null); });

const json = async (r: Response) => (await r.json()) as any;
const upload = async (cookie: string, body: Record<string, unknown>) => call("POST", "/api/meetings", { cookie, body, headers: { "x-wait": "1" } });
const items = async (id: string) => ((await db.select().from(meetings).where(eq(meetings.id, id)))[0]!.tasks as any[]);

describe("unified final pass", () => {
  test("items carry kind, label, confidence, evidence line numbers and verified quotes; the prompt has the date, weekday and roster", async () => {
    reply = () => ok([t({ title: "Send the deck", assigneeName: "Parag", assigneeId: "U_OTHER", dueDate: "Friday", quote: "I'll send the deck on Friday", evidence: [] })], { decisions: [{ text: "Ship on Monday", quote: "we ship on Monday", confidence: 0.9 }] });
    const { id } = await json(await upload(me, { title: "Sync", startedAt: "2026-10-24T09:00:00Z", text: "Dana: hello\nParag: I'll send the deck on Friday\nDana: and we ship on Monday" }));
    expect(calls[0]!.prompt).toContain("Meeting date: ");
    expect(calls[0]!.prompt).toContain("[2] Parag: I'll send the deck on Friday"); // numbered lines
    const all = await items(id);
    const task = all.find((i) => i.itemType === "task");
    expect(task).toMatchObject({ unverified: false, kind: "commitment", label: "confirmed", evidence: [2], assigneeId: "U_OTHER" });
    expect(all.find((i) => i.itemType === "decision")).toMatchObject({ title: "Ship on Monday", evidence: [3] });
  });

  test("an item without a supporting quote is KEPT as unverified and never becomes a task", async () => {
    reply = () => ok([t({ title: "Hire a designer", assigneeName: "Dana", assigneeId: "U_ME", quote: "we will definitely hire a designer next month" })]);
    const { id } = await json(await upload(me, { title: "Sync", text: "Dana: hello\nParag: nothing about hiring here" }));
    const [i] = await items(id);
    expect(i).toMatchObject({ title: "Hire a designer", unverified: true, approval: "proposed" });
    expect(i.confidence).toBeLessThanOrEqual(0.5);
    expect(await db.select().from(commitments)).toHaveLength(0);
    // and it cannot be approved in bulk
    const r = await json(await call("POST", `/api/meetings/${id}/approve`, { cookie: me, body: { itemIds: [i.id] } }));
    expect(r.approved).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ id: i.id, reason: "no supporting quote" });
  });

  test("invalid JSON gets one repair retry that carries the error; two failures mark the meeting failed with the reason", async () => {
    let n = 0;
    reply = () => (++n === 1 ? "sorry, here is some prose" : ok([t({ title: "Send the deck", assigneeId: "U_ME", assigneeName: "Dana", quote: "Dana will send the deck" })]));
    const { id } = await json(await upload(me, { title: "Sync", text: "Parag: Dana will send the deck" }));
    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toContain("Return valid JSON only");
    expect((await db.select().from(meetings).where(eq(meetings.id, id)))[0]).toMatchObject({ status: "ready", failedReason: null });
    reply = () => "never json";
    const bad = await json(await upload(me, { title: "Sync 2", text: "Parag: hello" }));
    const [row] = await db.select().from(meetings).where(eq(meetings.id, bad.id));
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.failedReason).toBeTruthy();
    expect(((await json(await call("GET", `/api/meetings/${bad.id}`, { cookie: me }))) as any).failedReason).toBeTruthy();
    // retry works only for a failed summary, and a good run clears the reason
    reply = () => ok();
    expect((await call("POST", `/api/meetings/${bad.id}/retry`, { cookie: me, headers: { "x-wait": "1" } })).status).toBe(202);
    expect((await db.select().from(meetings).where(eq(meetings.id, bad.id)))[0]).toMatchObject({ status: "ready", failedReason: null });
    expect((await call("POST", `/api/meetings/${bad.id}/retry`, { cookie: me })).status).toBe(403);
  });

  test("a 150k-character transcript is read in overlapping chunks, merged and de-duplicated", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) lines.push(`Dana: ${i === 20 ? "Parag will send the first invoice" : i === 1480 ? "Parag will send the last invoice" : `filler talk number ${i}`} ${"x".repeat(80)}`);
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(150_000);
    expect(text.length).toBeGreaterThan(SINGLE_PASS_CHARS);
    reply = (a) => {
      if (a.system.startsWith("Combine these partial")) return "## Discussion\n- merged notes";
      const first = a.prompt.includes("Parag will send the first invoice"), last = a.prompt.includes("Parag will send the last invoice");
      return ok([
        ...(first ? [t({ title: "Send the first invoice", assigneeName: "Parag", assigneeId: "U_OTHER", quote: "Parag will send the first invoice" })] : []),
        ...(last ? [t({ title: "Send the last invoice", assigneeName: "Parag", assigneeId: "U_OTHER", quote: "Parag will send the last invoice" })] : []),
      ]);
    };
    const { id } = await json(await upload(me, { title: "Long", text }));
    const chunkCalls = calls.filter((c) => !c.system.startsWith("Combine"));
    expect(chunkCalls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.system.startsWith("Combine"))).toBe(true);
    expect(chunkCalls.every((c) => c.prompt.length < CHUNK_CHARS + 12_000)).toBe(true);
    const titles = (await items(id)).map((i) => i.title).sort();
    expect(titles).toEqual(["Send the first invoice", "Send the last invoice"]); // both ends found, no duplicates
    expect((await db.select().from(meetings).where(eq(meetings.id, id)))[0]!.summary).toContain("merged notes");
    expect(((await items(id))[0]).evidence.length).toBe(1); // global line numbers survive chunking
  });
});

describe("tolerance and restatements", () => {
  test("a malformed item (no title) is repaired from its quote or dropped; it never fails the analysis", async () => {
    reply = () => JSON.stringify({ summary: "## Discussion\n- x", decisions: [{ quote: "we ship on Monday", confidence: 0.9 }, 7], tasks: [{ quote: "nothing useful" }, { title: "Send the deck", assigneeId: "U_ME", assigneeName: "Dana", quote: "Dana will send the deck" }, "junk"], questions: [{ quote: "who pays for it" }] });
    const { id } = await json(await upload(me, { title: "Sync", text: "Parag: we ship on Monday\nParag: Dana will send the deck\nParag: who pays for it" }));
    expect((await db.select().from(meetings).where(eq(meetings.id, id)))[0]!.status).toBe("ready");
    const all = await items(id);
    expect(all.find((i) => i.itemType === "decision")).toMatchObject({ title: "we ship on Monday", unverified: false });
    expect(all.find((i) => i.itemType === "question")!.title).toBe("who pays for it");
    expect(all.filter((i) => i.itemType === "task").map((i) => i.title)).toContain("Send the deck");
    // the live analyzer too
    setMemoryLlm(async () => JSON.stringify({ items: [{ kind: "decision", label: "confirmed", quote: "we ship on Monday" }, { kind: "task", title: "Send it", quote: "Dana will send the deck" }, { nonsense: true }] }));
    const live = await analyzeLiveMeeting([{ speaker: "Parag", text: "we ship on Monday" }, { speaker: "Parag", text: "Dana will send the deck" }], {});
    expect(live.items.map((i) => i.title)).toEqual(["we ship on Monday", "Send it"]);
  });

  test("a date that was said and then changed is kept as a visible conflict; the latest value is used for the task", async () => {
    reply = () => ok([t({ title: "Send the contract", assigneeName: "Parag", assigneeId: "U_OTHER", dueDate: "2026-11-02", quote: "Parag will send the contract by Friday no make it Monday", previously: [{ dueDate: "2026-10-30", assigneeName: null, quote: "by Friday" }] })]);
    const { id } = await json(await upload(me, { title: "Sync", channelId: "CPUB", startedAt: "2026-10-24T09:00:00Z", text: "Dana: Parag will send the contract by Friday no make it Monday" }));
    const [i] = await items(id);
    expect(i).toMatchObject({ approval: "approved", approvedBy: "auto", dueDate: "2026-11-02" });
    expect(i.ambiguity.conflicts).toEqual([expect.objectContaining({ type: "due", restated: true, with: expect.objectContaining({ dueDate: "2026-10-30" }) })]);
    expect((await db.select().from(commitments))[0]!.dueAt!.toISOString().slice(0, 10)).toBe("2026-11-02");
  });
});

describe("duplicates and conflicts", () => {
  const exist = (o: Partial<Parameters<typeof insertCommitment>[0]> = {}) => insertCommitment({ ownerId: "U_OTHER", ownerName: "Parag", text: "Send the revised deck to Acme", dueAt: new Date("2026-10-30T23:59:00Z"), sourceType: "message", sourceRef: `msg:x:${Math.random()}`, channelId: "CPUB", scopeTag: "shared", ...o });
  const run = async (tasks: unknown[], channelId?: string) => {
    reply = () => ok(tasks);
    return json(await upload(me, { title: "Sync", channelId, text: "Dana: Parag, send the revised deck to Acme by Friday\nDana: Dana will draft the plan" }));
  };
  const deck = (o: Record<string, unknown> = {}) => t({ title: "Send the revised deck to Acme", assigneeName: "Parag", assigneeId: "U_OTHER", dueDate: "2026-10-30", quote: "Parag, send the revised deck to Acme by Friday", ...o });

  test("same task, same owner and date: auto-merged into the existing task, no second task", async () => {
    const existing = await exist();
    const { id } = await run([deck()], "CPUB");
    const [i] = await items(id);
    expect(i).toMatchObject({ approval: "approved", approvedBy: "auto", merged: true, commitmentId: existing!.id });
    expect(i.ambiguity.duplicateOf[0]).toMatchObject({ source: "task", id: existing!.id });
    expect(await db.select().from(commitments)).toHaveLength(1);
    // "Undo merge" clears the flag and makes it its own task
    const r = await call("POST", `/api/meetings/${id}/items/${i.id}/dismiss-duplicate`, { cookie: me });
    expect(r.status).toBe(200);
    const [after] = await items(id);
    expect(after.merged).toBeFalsy();
    expect(after.ambiguity.duplicateOf).toEqual([]);
  });

  test("same task, different due date or owner: created anyway, flagged as a conflict", async () => {
    await exist({ dueAt: new Date("2026-11-15T23:59:00Z"), ownerId: "U_ME", ownerName: "Dana" });
    const { id } = await run([deck()], "CPUB");
    const [i] = await items(id);
    expect(i).toMatchObject({ approval: "approved" });
    expect(i.merged).toBeFalsy();
    expect(i.ambiguity.conflicts.map((c: any) => c.type).sort()).toEqual(["due", "owner"]);
    expect(i.ambiguity.conflicts[0].with).toMatchObject({ title: "Send the revised deck to Acme" });
    expect((await db.select().from(commitments)).filter((c) => c.sourceType === "meeting")).toHaveLength(1);
    expect((await call("POST", `/api/meetings/${id}/items/${i.id}/dismiss-conflict`, { cookie: me })).status).toBe(200);
    expect((await items(id))[0].ambiguity.conflicts).toEqual([]);
  });

  test("a similar task from another recent meeting in the same channel is flagged; the same task twice in one meeting is merged away", async () => {
    await run([deck()], "CPUB"); // first meeting makes the task
    reply = () => ok([deck(), deck({ title: "Send revised deck Acme", quote: "send the revised deck to Acme" })]);
    const { id } = await json(await upload(me, { title: "Second", channelId: "CPUB", text: "Dana: Parag, send the revised deck to Acme by Friday" }));
    const rows = await items(id);
    expect(rows).toHaveLength(1); // the two wordings are one item
    expect(rows[0]).toMatchObject({ merged: true });
    expect(await db.select().from(commitments)).toHaveLength(1);
  });

  test("duplicates are not compared across scopes: a private channel task never shows up as a duplicate in a public meeting", async () => {
    await exist({ channelId: "CPRIV", scopeTag: "channel_CPRIV" });
    const { id } = await run([deck()], "CPUB");
    const [i] = await items(id);
    expect(i.ambiguity.duplicateOf).toEqual([]);
    expect(i.merged).toBeFalsy();
  });
});

describe("upload route", () => {
  test("a member's upload is private to them; another member cannot list or open it", async () => {
    reply = () => ok([t({ title: "Draft plan", assigneeName: "Dana", assigneeId: "U_ME", quote: "Dana will draft the plan" })]);
    const { id } = await json(await upload(me, { title: "Mine", text: "Parag: Dana will draft the plan" }));
    const m = await json(await call("GET", `/api/meetings/${id}`, { cookie: me }));
    expect(m).toMatchObject({ status: "ready", mode: "auto", autoConfidence: 0.6 });
    expect(m.lines).toEqual([{ n: 1, speaker: "Parag", text: "Dana will draft the plan" }]);
    expect(m.counts).toMatchObject({ confirmed: 1 });
    expect((await call("GET", `/api/meetings/${id}`, { cookie: other })).status).toBe(404);
    expect((await json(await call("GET", "/api/meetings", { cookie: other }))).map((x: any) => x.id)).not.toContain(id);
    expect((await call("PATCH", `/api/meetings/${id}/items/${m.items[0].id}`, { cookie: other, body: { approval: "rejected" } })).status).toBe(404);
    const tasks = (await json(await call("GET", "/api/tasks", { cookie: other }))).tasks;
    expect(tasks).toEqual([]);
    expect((await json(await call("GET", "/api/tasks", { cookie: me }))).tasks).toHaveLength(1);
  });

  test("with a channel the uploader belongs to, the meeting is scoped like that channel; otherwise 403", async () => {
    const { id } = await json(await upload(me, { title: "In channel", channelId: "CPRIV", text: "Parag: hi" }));
    expect((await db.select().from(meetings).where(eq(meetings.id, id)))[0]).toMatchObject({ channelId: "CPRIV", ownerId: "U_ME" });
    expect((await call("GET", `/api/meetings/${id}`, { cookie: other })).status).toBe(404); // not a member
    const denied = await upload(other, { title: "x", channelId: "CPRIV", text: "Parag: hi" });
    expect(denied.status).toBe(403);
    await expect(createUploadedMeeting({ userId: "U_OTHER", role: "member" }, { title: "x", text: "hi", channelId: "CNOPE" })).rejects.toBeInstanceOf(UploadError);
  });

  test("validation: empty text 400 invalid_body, body limit 413, formats are parsed server-side, secrets scrubbed", async () => {
    const empty = await upload(me, { title: "x", text: "   " });
    expect(empty.status).toBe(400);
    expect(((await json(empty)) as any).error).toBe("invalid_body");
    expect((await upload(me, { text: "Dana: hi" })).status).toBe(400); // title is required
    const big = await call("POST", "/api/meetings", { cookie: me, body: { title: "x", text: "a".repeat(10) }, headers: { "content-length": String(3 * 1024 * 1024) } });
    expect(big.status).toBe(413);
    const vtt = await json(await upload(me, { title: "v", format: "vtt", text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana>the token is xoxb-1234567890-abcdefghij</v>\n" }));
    const row = (await db.select().from(meetings).where(eq(meetings.id, vtt.id)))[0]!;
    expect(row.transcript).toBe("Ana: [removed: looked like a secret]");
    expect(row.platform).toBe("web");
  });

  test("reanalyze: owner or admin only, items and approvals carry over without duplicating tasks", async () => {
    reply = () => ok([t({ title: "Draft plan", assigneeName: "Dana", assigneeId: "U_ME", quote: "Dana will draft the plan" })]);
    const { id } = await json(await upload(me, { title: "Mine", channelId: "CPUB", text: "Parag: Dana will draft the plan" }));
    const before = await items(id);
    expect((await call("POST", `/api/meetings/${id}/reanalyze`, { cookie: other })).status).toBe(403); // can read the public channel meeting, but is not its owner
    expect((await call("POST", `/api/meetings/${id}/reanalyze`, { cookie: me, headers: { "x-wait": "1" } })).status).toBe(202);
    const after = await items(id);
    expect(after.map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect((await db.select().from(commitments)).length).toBe(1);
    expect((await getMeeting(id, { userId: "U_ME", role: "member" }))!.items[0]).toMatchObject({ approval: "approved", approvedBy: "auto" });
  });
});
