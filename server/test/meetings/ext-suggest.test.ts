import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commitments, users } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { suggestAssignees } from "../../src/meetings/suggest";
import { app, call, db, login, resetDb } from "../api/helpers";
import { fakeVector, seedChannel, seedMemory } from "../memory/helpers";

const DAY = 24 * 3600 * 1000;
let n = 0;
const task = (ownerId: string, text: string, extra: Partial<typeof commitments.$inferInsert> = {}) =>
  ({ id: `c${++n}`, ownerId, text, sourceType: "message" as const, sourceRef: `msg:${n}`, scopeTag: "shared", status: "open" as const, ...extra });

beforeEach(async () => {
  await resetDb();
  n = 0;
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
    // Bob's private-channel workload is invisible to the requester and must not be counted.
    ...Array.from({ length: 10 }, (_, i) => task("U_BOB", `Secret item ${i}`, { scopeTag: "channel_CSECRET" })),
  ]);
  await seedMemory("shared", "Cara knows the dashboard frontend very well and built the first version.");
  await seedMemory("shared", "Bob is on vacation next week.");
});
afterEach(() => setEmbedder(null));

describe("assignee suggestions", () => {
  test("rank by skill and availability, with the evidence behind each suggestion", async () => {
    const out = await suggestAssignees("U_ME", [{ id: "t1", title: "Set up the database migrations" }, { id: "t2", title: "Build the dashboard frontend" }], { roster: ["Bob"], limit: 10 });
    const [t1, t2] = out.tasks;
    expect(t1!.candidates[0]!.name).toBe("Ana Silva");                                   // finished a similar task, light load
    expect(t1!.candidates[0]!.reasons.join(" ")).toContain("Did something similar");
    expect(t1!.candidates[0]!.reasons.join(" ")).toContain("Role: Database engineer");
    expect(t2!.candidates[0]!.name).toBe("Cara Lee");                                    // memory says she knows the topic
    expect(t2!.candidates[0]!.reasons.join(" ")).toContain("In memory");
    const bob = t1!.candidates.find((c) => c.name === "Bob Stone") ?? t2!.candidates.find((c) => c.name === "Bob Stone");
    expect(bob).toBeDefined();
    expect(bob!.load.open).toBe(8);                                                      // the 10 private-channel tasks are not counted
    expect(bob!.load.overdue).toBe(3);
    expect(bob!.availability).toBe("overloaded");
    expect(bob!.possibleTimeOff).toBe(true);
    expect(bob!.reasons.join(" ")).toContain("Possible time off");
    expect(bob!.onCall).toBe(true);
    expect(t1!.candidates.every((c) => c.score >= 0 && c.score <= 1)).toBe(true);
    expect(out.basis.note).toContain("before the task's deadline");
  });

  test("availability is judged against the new task's own deadline", async () => {
    await db.insert(users).values([{ id: "U_DEE", name: "Dee Park" }, { id: "U_EEL", name: "Eel Moss" }]);
    const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
    await db.insert(commitments).values([
      ...Array.from({ length: 4 }, (_, i) => task("U_DEE", `Dee later job ${i}`, { dueAt: new Date(Date.now() + 20 * DAY) })), // same count as Eel, but far away
      ...Array.from({ length: 4 }, (_, i) => task("U_EEL", `Eel urgent job ${i}`, { dueAt: new Date(Date.now() + 1 * DAY) })), // all due before a 3-day deadline
    ]);
    const rank = async (due: string) => {
      const c = (await suggestAssignees("U_ME", [{ id: "t", title: "Zzyzx quarterly frobnication", due }], { limit: 10 })).tasks[0]!.candidates;
      return { dee: c.find((x) => x.userId === "U_DEE")!, eel: c.find((x) => x.userId === "U_EEL")! };
    };
    const soon = await rank(iso(3));
    expect(soon.eel.load.dueBefore).toBe(4);
    expect(soon.dee.load.dueBefore).toBe(0);
    expect(soon.dee.score).toBeGreaterThan(soon.eel.score);                  // Dee's work is due after this deadline, Eel's before it
    expect(soon.eel.reasons.join(" ")).toContain(`more due before ${iso(3)}`);
    const far = await rank(iso(40));                                          // with a distant deadline both must clear everything first
    expect(far.dee.load.dueBefore).toBe(4);
    expect(far.dee.score).toBe(far.eel.score);
  });

  test("generic words like 'handle' are not skill evidence", async () => {
    await db.insert(commitments).values(task("U_CARA", "Handle the onboarding emails", { status: "done", completedAt: new Date(Date.now() - 3 * DAY) }));
    const out = await suggestAssignees("U_ME", [{ id: "t", title: "Handle the quarterly invoices" }], { limit: 10 });
    expect(out.tasks[0]!.noSkillSignal).toBe(true);
    expect(out.tasks[0]!.candidates.every((c) => c.skill === 0)).toBe(true);
  });

  test("with no skill signal anywhere it says so and ranks by availability alone", async () => {
    const out = await suggestAssignees("U_ME", [{ id: "t", title: "Zzyzx quarterly frobnication" }]);
    expect(out.tasks[0]!.noSkillSignal).toBe(true);
    expect(out.tasks[0]!.candidates[0]!.name).not.toBe("Bob Stone"); // the overloaded person is never first
  });

  test("the endpoint needs a token and a valid body", async () => {
    const tok = (await (await call("POST", "/api/meetings/extension-token", { cookie: await login("U_X", "member") })).json() as any).token;
    const post = (headers: Record<string, string>, body: unknown) => app.request("/ext/suggest", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({}, { tasks: [{ id: "a", title: "x" }] })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${tok}` }, { tasks: [] })).status).toBe(400);
    const ok = await post({ authorization: `Bearer ${tok}` }, { tasks: [{ id: "a", title: "Set up the database migrations" }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).tasks[0].candidates.length).toBeGreaterThan(0);
  });
});
