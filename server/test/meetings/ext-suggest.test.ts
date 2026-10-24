import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commitments, users } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { suggestAssignees } from "../../src/meetings/suggest";
import { app, call, db, login, resetDb } from "../api/helpers";
import { fakeVector, seedChannel, seedMemory } from "../memory/helpers";

const DAY = 24 * 3600 * 1000;
let n = 0;
const task = (ownerId: string, text: string, extra: Partial<typeof commitments.$inferInsert> = {}) =>
  ({ id: `c${++n}`, ownerId, text, sourceType: "message" as const, sourceRef: `msg:${n}`, scopeTag: "shared", status: "open" as const, ...extra });

// Ids the model is shown, read back from the prompt so a stub can answer like a real model would.
const pOf = (prompt: string, name: string) => new RegExp(`\\[(P\\d+)\\] ${name}`).exec(prompt)![1]!;
const tOf = (prompt: string, text: string) => new RegExp(`\\[(T\\d+)\\][^\\n]*${text}`).exec(prompt)![1]!;
const mOf = (prompt: string, text: string) => new RegExp(`\\[(M[\\d.]+)\\][^\\n]*${text}`).exec(prompt)![1]!;
const aOf = (prompt: string, text: string) => new RegExp(`\\[(A\\d+)\\][^\\n]*${text}`).exec(prompt)![1]!;
const answer = (tasks: unknown) => JSON.stringify({ tasks });
const rank = (person: string, o: Record<string, unknown> = {}) => ({ person, skillFit: 0, skillReason: "", skillEvidence: [], availability: "light", availabilityReason: "", timeOffEvidence: [], ...o });

let prompts: string[] = [];
const judge = (fn: (prompt: string) => string) => setMemoryLlm(async (a) => { if (!a.system.includes("recommend who should take")) return "{}"; prompts.push(a.prompt); return fn(a.prompt); });

beforeEach(async () => {
  await resetDb();
  n = 0; prompts = [];
  setEmbedder(async (t) => t.map(fakeVector));
  await login("U_ME", "member");
  await db.insert(users).values([
    { id: "U_ANA", name: "Ana Silva", title: "Database engineer" },
    { id: "U_BOB", name: "Bob Stone" },
    { id: "U_CARA", name: "Cara Lee" },
  ]);
  await seedChannel("CSECRET", { isPrivate: true, members: ["U_BOB"] });
  await db.insert(commitments).values([
    task("U_ANA", "Set up the database migrations for billing", { status: "done", completedAt: new Date(Date.now() - 10 * DAY) }),
    ...Array.from({ length: 8 }, (_, i) => task("U_BOB", `Bob open item ${i}`, { dueAt: new Date(Date.now() + (i < 3 ? -2 : 3) * DAY) })),
    ...Array.from({ length: 10 }, (_, i) => task("U_BOB", `Secret item ${i}`, { scopeTag: "channel_CSECRET" })), // invisible to the requester
  ]);
  await seedMemory("shared", "Cara Lee knows the dashboard frontend very well and built the first version.");
  await seedMemory("shared", "Bob Stone is on vacation next week.");
  await seedMemory("channel_CSECRET", "Secret: the dashboard rebuild budget is confidential.");
});
afterEach(() => { setEmbedder(null); setMemoryLlm(null); });

describe("assignee suggestions", () => {
  test("the model is given the tracker facts and memory the person may read, and nothing they may not", async () => {
    judge(() => answer([]));
    const due = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    await suggestAssignees("U_ME", [{ id: "t", title: "Build the dashboard frontend", due }], { roster: ["Bob"] });
    const p = prompts[0]!;
    expect(p).toContain("Set up the database migrations for billing");   // Ana's finished task, with its status
    expect(p).toMatch(/\[T\d+\] done 10 days ago/);
    expect(p).toContain("OVERDUE");                                       // Bob's late work is stated as a fact
    expect(p).toContain(`due ${due}`);                                    // the task's own deadline
    expect(p).toContain("Today: ");
    expect(p).toContain("Cara Lee knows the dashboard frontend");         // shared memory
    expect(p).toContain("Bob Stone is on vacation");                      // time off, found by meaning, not a keyword list
    expect(p).toContain("(on this call now)");
    expect(p).not.toContain("Secret item");                               // private-channel tasks and memory stay out
    expect(p).not.toContain("confidential");
  });

  test("evidence the model cites is verified, shown, and the ranking is kept as given", async () => {
    judge((p) => answer([{ task: "K1", ranked: [
      rank(pOf(p, "Cara Lee"), { skillFit: 0.8, skillReason: "Built the first dashboard version.", skillEvidence: [mOf(p, "Cara Lee knows the dashboard")], availability: "light", availabilityReason: "Nothing assigned right now." }),
      rank(pOf(p, "Ana Silva"), { skillFit: 0.5, skillReason: "Did similar database work.", skillEvidence: [tOf(p, "database migrations")], availability: "light" }),
      rank(pOf(p, "Bob Stone"), { skillFit: 0, availability: "overloaded", availabilityReason: "Three overdue tasks.", timeOffEvidence: [aOf(p, "Bob Stone is on vacation")] }),
    ] }]));
    const out = await suggestAssignees("U_ME", [{ id: "t", title: "Build the dashboard frontend" }], { limit: 10 });
    const c = out.tasks[0]!.candidates;
    expect(c.map((x) => x.name)).toEqual(["Cara Lee", "Ana Silva", "Bob Stone"]);          // the model's order
    expect(c[0]!.skill).toBe(0.8);
    expect(c[0]!.reasons.join(" ")).toContain("In memory: “Cara Lee knows the dashboard frontend very well and built the first version.”");
    expect(c[1]!.reasons.join(" ")).toContain("Did (10 days ago): “Set up the database migrations for billing”");
    expect(c[2]!.possibleTimeOff).toBe(true);
    expect(c[2]!.reasons.join(" ")).toContain("Possible time off");
    expect(c[2]!.load).toMatchObject({ open: 8, overdue: 3 });                              // counts come from the tracker, not the model
    expect(c[2]!.reasons.join(" ")).toContain("8 open · 3 overdue");
    expect(out.tasks[0]!.noSkillSignal).toBe(false);
  });

  test("a claim whose evidence does not check out is dropped", async () => {
    judge((p) => answer([{ task: "K1", ranked: [
      // Ana cites Bob's task, a memory snippet that is about Cara, and one that does not exist: none of it is hers.
      rank(pOf(p, "Ana Silva"), { skillFit: 0.9, skillReason: "Expert.", skillEvidence: [tOf(p, "Bob open item 0"), mOf(p, "Cara Lee knows the dashboard"), "M9.9"], timeOffEvidence: [aOf(p, "Bob Stone is on vacation")] }),
      rank("P99", { skillFit: 1, skillEvidence: ["T1"] }),                                   // not a person in the prompt
      rank(pOf(p, "Ana Silva"), { skillFit: 1 }),                                             // a duplicate
    ] }]));
    const out = await suggestAssignees("U_ME", [{ id: "t", title: "Build the dashboard frontend" }], { limit: 10 });
    const c = out.tasks[0]!.candidates;
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toBe("Ana Silva");
    expect(c[0]!.skill).toBe(0);                                                             // unsupported, so no skill is claimed
    expect(c[0]!.reasons[0]).toBe("No evidence of related experience found");
    expect(c[0]!.reasons.join(" ")).not.toContain("Expert");
    expect(c[0]!.possibleTimeOff).toBe(false);                                               // Bob's vacation note is not Ana's
    expect(out.tasks[0]!.noSkillSignal).toBe(true);
  });

  test("availability is judged per task against its own deadline", async () => {
    await db.insert(users).values([{ id: "U_DEE", name: "Dee Park" }, { id: "U_EEL", name: "Eel Moss" }]);
    await db.insert(commitments).values([
      ...Array.from({ length: 4 }, (_, i) => task("U_DEE", `Dee later job ${i}`, { dueAt: new Date(Date.now() + 20 * DAY) })),
      ...Array.from({ length: 4 }, (_, i) => task("U_EEL", `Eel urgent job ${i}`, { dueAt: new Date(Date.now() + 1 * DAY) })),
    ]);
    judge((p) => answer([{ task: "K1", ranked: [rank(pOf(p, "Dee Park")), rank(pOf(p, "Eel Moss"))] }, { task: "K2", ranked: [rank(pOf(p, "Dee Park")), rank(pOf(p, "Eel Moss"))] }]));
    const iso = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
    const out = await suggestAssignees("U_ME", [{ id: "soon", title: "Zzyzx frobnication", due: iso(3) }, { id: "far", title: "Quarterly frobnication", due: iso(40) }], { limit: 10 });
    expect(prompts[0]).toMatch(/Dee Park[\s\S]*?K1: 0 more due before it; K2: 4 more due before it/);
    expect(prompts[0]).toMatch(/Eel Moss[\s\S]*?K1: 4 more due before it; K2: 4 more due before it/);
    const at = (id: string, uid: string) => out.tasks.find((t) => t.id === id)!.candidates.find((c) => c.userId === uid)!;
    expect(at("soon", "U_DEE").load.dueBefore).toBe(0);
    expect(at("soon", "U_EEL").load.dueBefore).toBe(4);
    expect(at("far", "U_DEE").load.dueBefore).toBe(4);
  });

  test("when the model is unavailable it says so and orders by workload alone, claiming no skill", async () => {
    setMemoryLlm(async () => { throw new Error("model down"); });
    const out = await suggestAssignees("U_ME", [{ id: "t", title: "Build the dashboard frontend" }], { limit: 10 });
    expect(out.basis.degraded).toBe(true);
    expect(out.basis.note).toContain("model was unavailable");
    const c = out.tasks[0]!.candidates;
    expect(c.every((x) => x.skill === 0 && x.availability === null)).toBe(true);
    expect(c[c.length - 1]!.name).toBe("Bob Stone");                                         // the most loaded person is last
    expect(out.tasks[0]!.noSkillSignal).toBe(true);
  });

  test("the endpoint needs a token and a valid body", async () => {
    judge(() => answer([]));
    const tok = (await (await call("POST", "/api/meetings/extension-token", { cookie: await login("U_X", "member") })).json() as any).token;
    const post = (headers: Record<string, string>, body: unknown) => app.request("/ext/suggest", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({}, { tasks: [{ id: "a", title: "x" }] })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${tok}` }, { tasks: [] })).status).toBe(400);
    const ok = await post({ authorization: `Bearer ${tok}` }, { tasks: [{ id: "a", title: "Set up the database migrations" }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).tasks[0].candidates.length).toBeGreaterThan(0);
  });
});
