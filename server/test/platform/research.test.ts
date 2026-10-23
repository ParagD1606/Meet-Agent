import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { researchRuns } from "../../src/db/schema";
import { MAX_ACTIVE_PER_USER, parsePlan, runResearch, startResearch, type ResearchDeps } from "../../src/research";
import { seedWorld } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await seedWorld();
});

const insertRun = (id: string, o: Partial<typeof researchRuns.$inferInsert> = {}) =>
  db.insert(researchRuns).values({ id, requesterId: "UMEM", channelId: "CPUB", threadTs: "1.1", question: "Who are our rivals?", ...o });
const get = async (id: string) => (await db.select().from(researchRuns).where(eq(researchRuns.id, id)))[0]!;

function fakes(over: Partial<ResearchDeps["llm"]> = {}) {
  const seen = { ctx: null as any, posts: [] as any[], investigated: [] as string[], findings: [] as any[] };
  const deps: ResearchDeps = {
    llm: {
      plan: async () => ["What is A?", "What is B?", "What is C?"],
      investigate: async (sub, parent, tools) => {
        seen.investigated.push(sub);
        expect(parent).toBe("Who are our rivals?");
        expect(Object.keys(tools)).toEqual(["memory_search"]);
        return `answer to ${sub}`;
      },
      synthesize: async (_q, findings) => ((seen.findings = findings), "FINAL BRIEF"),
      ...over,
    },
    tools: async (ctx) => ((seen.ctx = ctx), { memory_search: {} as any }),
    post: async (channel, thread, text) => void seen.posts.push({ channel, thread, text }),
  };
  return { deps, seen };
}

test("pipeline: plan -> parallel investigate -> synthesize -> post to thread", async () => {
  await insertRun("rs1");
  const { deps, seen } = fakes();
  expect(await runResearch("rs1", deps)).toBe("done");
  expect(seen.investigated.sort()).toEqual(["What is A?", "What is B?", "What is C?"]);
  expect(seen.findings).toHaveLength(3);
  expect(seen.posts).toEqual([{ channel: "CPUB", thread: "1.1", text: "FINAL BRIEF" }]);
  expect(seen.ctx).toMatchObject({ userId: "UMEM", channelId: "CPUB", readOnly: true, orgConnectionsOnly: true, scope: { isPrivate: false, isIm: false, userId: "UMEM" } });
  const r = await get("rs1");
  expect(r).toMatchObject({ status: "done", result: "FINAL BRIEF", plan: { subQuestions: ["What is A?", "What is B?", "What is C?"] } });
});

test("one failing sub-question does not sink the run; unknown channel is scoped as private", async () => {
  await insertRun("rs2", { channelId: "CGHOST" });
  const { deps, seen } = fakes({
    investigate: async (sub) => {
      if (sub === "What is B?") throw new Error("search down");
      return `answer to ${sub}`;
    },
  });
  expect(await runResearch("rs2", deps)).toBe("done");
  expect(seen.findings.map((f) => f.question)).toEqual(["What is A?", "What is C?"]);
  expect(seen.ctx.scope.isPrivate).toBe(true);
});

test("all sub-questions failing marks the run failed and tells the thread", async () => {
  await insertRun("rs3");
  const { deps, seen } = fakes({ investigate: async () => { throw new Error("nope"); } });
  expect(await runResearch("rs3", deps)).toBe("failed");
  expect((await get("rs3")).status).toBe("failed");
  expect(seen.posts[0].text).toContain("couldn't finish");
});

test("empty plan falls back to the original question; synthesis error fails the run", async () => {
  await insertRun("rs4");
  const a = fakes({ plan: async () => [] });
  expect(await runResearch("rs4", a.deps)).toBe("done");
  expect(a.seen.investigated).toEqual(["Who are our rivals?"]);
  await insertRun("rs5");
  const b = fakes({ synthesize: async () => "   " });
  expect(await runResearch("rs5", b.deps)).toBe("failed");
});

test("a run is claimed once: re-running a non-planned run is skipped", async () => {
  await insertRun("rs6");
  const { deps, seen } = fakes();
  await runResearch("rs6", deps);
  expect(await runResearch("rs6", deps)).toBe("skipped");
  expect(seen.posts).toHaveLength(1);
  expect(await runResearch("missing", deps)).toBe("skipped");
});

test("startResearch rejects empty questions and caps active runs per user", async () => {
  await expect(startResearch({ requesterId: "UMEM", channelId: "CPUB", question: "  " })).rejects.toThrow("question required");
  for (let i = 0; i < MAX_ACTIVE_PER_USER; i++) await insertRun(`act${i}`, { status: i % 2 ? "running" : "planned" });
  await expect(startResearch({ requesterId: "UMEM", channelId: "CPUB", question: "more?" })).rejects.toThrow("too many");
});

test("parsePlan strips bullets, dedupes, caps at 5", () => {
  expect(parsePlan("1. one thing\n- one thing\n* second thing\n\n3) third thing\nx\nfourth q\nfifth q\nsixth q")).toEqual([
    "one thing", "second thing", "third thing", "fourth q", "fifth q",
  ]);
});
