import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { episodes } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { recallForMeeting } from "../../src/meetings";
import { app, call, db, login, mkUser, resetDb } from "../api/helpers";
import { fakeVector, seedChannel, seedMemory } from "../memory/helpers";

let me: string;
beforeEach(async () => {
  await resetDb();
  setEmbedder(async (t) => t.map(fakeVector));
  me = await login("U_ME", "member");
  await mkUser("U_OTHER", "member");
  await seedChannel("CPRIV", { isPrivate: true, members: ["U_ME"] });
  await seedChannel("CSECRET", { isPrivate: true, members: ["U_OTHER"] });
  await seedMemory("shared", "The launch date for the outreach campaign is October 30th.");
  await seedMemory("channel_CPRIV", "In our private channel we agreed outreach pricing uses three tiers.");
  await seedMemory("channel_CSECRET", "Confidential outreach layoffs are planned for November.");
  await seedMemory("user_U_ME", "Parag prefers outreach meetings on Fridays.");
  await seedMemory("user_U_OTHER", "Someone else's private outreach salary note.");
});
afterEach(() => { setEmbedder(null); setMemoryLlm(null); });

const json = async (r: Response) => (await r.json()) as any;
const token = async () => (await json(await call("POST", "/api/meetings/extension-token", { cookie: me }))).token as string;
const post = (path: string, tok: string, body: unknown, wait = false) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...(wait ? { "x-wait": "1" } : {}) }, body: JSON.stringify(body) });

describe("extension memory", () => {
  test("recall reads exactly what this person may read: shared, their own DMs, private channels they belong to", async () => {
    const recall = async (q: string) => (await recallForMeeting("U_ME", q)).text;
    expect(await recall("when is the outreach campaign launch date")).toContain("October 30th");   // shared
    expect(await recall("what does outreach pricing use")).toContain("three tiers");               // private channel they belong to
    expect(await recall("which day does Parag prefer for outreach meetings")).toContain("Fridays"); // their own DM scope
    // Memories they may not read stay hidden even when the question targets them directly.
    expect(await recall("confidential outreach layoffs planned for November")).not.toContain("layoffs"); // private channel they are not in
    expect(await recall("someone else's private outreach salary note")).not.toContain("salary");        // another person's DM
    const { sources } = await recallForMeeting("U_ME", "when is the outreach campaign launch date");
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((x) => x.date.length === 10)).toBe(true);
  });

  test("ask answers from the meeting and memory, and returns the sources it used", async () => {
    let seen = { system: "", prompt: "" };
    setMemoryLlm(async (a) => { seen = { system: a.system, prompt: a.prompt }; return "The launch date was set earlier, per memory: October 30th."; });
    const res = await post("/ext/ask", await token(), { lines: [{ speaker: "Ana", text: "When do we launch?" }], question: "What was the launch date for the outreach campaign?", context: { title: "Planning" } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.answer).toContain("October 30th");
    expect(seen.prompt).toContain("Team memory");
    expect(seen.prompt).toContain("launch date for the outreach campaign");
    expect(seen.prompt).not.toContain("layoffs");
    expect(seen.system).toContain("transcript wins");
    expect(body.sources.some((s: any) => /launch date/.test(s.text))).toBe(true);
  });

  test("the final pass may use memory to understand references but can never make an item from it", async () => {
    let prompt = "";
    setMemoryLlm(async (a) => {
      if (!a.system.includes("meeting source material")) return "ok";
      prompt = a.prompt;
      return JSON.stringify({
        summary: "Talked about outreach.", decisions: [{ text: "Launch on October 30th", quote: "The launch date for the outreach campaign is October 30th" }], // only in memory
        tasks: [{ title: "Send the deck", description: "", assigneeName: "Ana", assigneeId: null, dueDate: null, quote: "Ana will send the deck" }],
      });
    });
    const res = await post("/ext/meetings", await token(), { externalId: "mem1", platform: "meet", title: "Outreach sync", participants: ["Ana"], lines: [{ speaker: "Ana", text: "Ana will send the deck for the outreach campaign." }] }, true);
    const m = await json(await call("GET", `/api/meetings/${(await json(res)).id}`, { cookie: me }));
    expect(prompt).toContain("Background");
    expect(prompt).toContain("launch date for the outreach campaign"); // memory reached the model...
    expect(m.decisions).toEqual([]);                                   // ...but its decision was not said in the meeting, so it is dropped
    expect(m.tasks.map((t: any) => t.title)).toEqual(["Send the deck"]);
  });

  test("a finished extension meeting is remembered privately for the person who held it", async () => {
    setMemoryLlm(async (a) => (a.system.includes("meeting source material")
      ? JSON.stringify({ summary: "The team agreed the outreach plan: start with email, then LinkedIn later. ".repeat(3), decisions: [{ text: "Use email first", quote: "we will use email first" }], tasks: [] })
      : a.system.includes("durable company knowledge") ? '{"facts":["The outreach plan uses email first."]}' : a.system.includes("superseded") ? '{"superseded":[]}' : "Outreach plan meeting: email first."));
    await post("/ext/meetings", await token(), { externalId: "mem2", platform: "meet", title: "Plan", participants: ["Ana"], lines: [{ speaker: "Ana", text: "Okay we will use email first for the outreach." }] }, true);
    const eps = await db.select().from(episodes);
    expect(eps.map((e) => e.scopeTag)).toEqual(["user_U_ME"]); // never shared, never another person's
    const mine = await recallForMeeting("U_ME", "outreach plan email first");
    expect(mine.text.toLowerCase()).toContain("email first");
    const theirs = await recallForMeeting("U_OTHER", "outreach plan email first");
    expect(theirs.text.toLowerCase()).not.toContain("email first");
  });
});
