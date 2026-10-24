// Live e2e finding: undoConsolidation() had no caller; procedures were re-proposed every night.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { episodes, memories, memoryReviews } from "../../src/db/schema";
import { consolidate } from "../../src/memory/consolidate";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { call, db, login, resetDb } from "./helpers";
import { fakeVector } from "../memory/helpers";

let admin: string, member: string;
const json = (r: Response) => r.json() as Promise<any>;
let proc = 0;

beforeAll(() => {
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(async (a) => {
    if (a.system.includes("reusable PROCEDURES")) return `{"facts":["Procedure variant ${++proc}: after QA sign-off the on-call tags the release and posts it in the channel."]}`;
    if (a.system.includes("ONE sentence")) return "A channel about releases.";
    return '{"superseded":[],"facts":[]}';
  });
});
afterAll(() => { setEmbedder(null); setMemoryLlm(null); });
beforeEach(async () => { await resetDb(); proc = 0; admin = await login("UA", "admin"); member = await login("UM", "member"); });

const old = new Date(Date.now() - 60 * 86_400_000);
const mk = (text: string, extra: Partial<typeof memories.$inferInsert> = {}) => db.insert(memories).values({ scopeTag: "shared", text, embedding: fakeVector(text), validAt: old, ...extra }).returning({ id: memories.id });

describe("consolidation undo route", () => {
  test("admin lists the log and undoes an entry; member forbidden; double undo 409", async () => {
    const [a] = await mk("Atlas deploys happen on Tuesdays and Thursdays in the afternoon");
    await mk("Atlas deploys happen on Tuesdays and Thursdays in the afternoon too", { accessCount: 5 });
    const r = await consolidate();
    expect(r.merged).toBe(1);
    expect((await call("GET", "/api/consolidation-log", { cookie: member })).status).toBe(403);
    const list = await json(await call("GET", "/api/consolidation-log", { cookie: admin }));
    const merge = list.find((e: any) => e.action === "merge");
    expect(merge).toMatchObject({ scopeTag: "shared", count: 1, undoneAt: null });
    expect((await call("POST", `/api/consolidation-log/${merge.id}/undo`, { cookie: member })).status).toBe(403);
    expect((await call("POST", `/api/consolidation-log/${merge.id}/undo`, { cookie: admin })).status).toBe(200);
    expect((await call("POST", `/api/consolidation-log/${merge.id}/undo`, { cookie: admin })).status).toBe(409);
    expect((await call("POST", "/api/consolidation-log/99999/undo", { cookie: admin })).status).toBe(404);
    const rows = await db.select({ s: memories.status }).from(memories);
    expect(rows.every((x) => x.s === "active")).toBe(true);
    expect(a!.id).toBeGreaterThan(0);
  });

  test("private-scope log entries never expose their scope tag", async () => {
    await mk("secret merge candidate about the board and acquisition ceiling for deal alpha", { scopeTag: "channel_GSECRET" });
    await mk("secret merge candidate about the board and acquisition ceiling for deal alpha too", { scopeTag: "channel_GSECRET", accessCount: 3 });
    await consolidate();
    const list = await json(await call("GET", "/api/consolidation-log", { cookie: admin }));
    expect(list.some((e: any) => e.action === "merge")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("GSECRET");
  });
});

describe("procedure extraction does not pile up near-duplicate reviews", () => {
  test("a second nightly run is a no-op while the first batch awaits review", async () => {
    for (const i of [0, 1]) {
      const s = `Thread ${i}: releases go out after QA sign-off and the on-call posts in the channel`;
      await db.insert(episodes).values({ id: `ep${i}`, scopeTag: "shared", channelId: "CENG", threadTs: `1.${i}`, summary: s, embedding: fakeVector(s) });
    }
    expect((await consolidate()).procedures).toBe(1);
    expect((await consolidate()).procedures).toBe(0);
    expect((await db.select().from(memoryReviews)).filter((r) => r.kind === "procedure")).toHaveLength(1);
  });
});
