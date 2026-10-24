// Demo kit: seed-demo-meetings is idempotent and uses the MeetingItem shape; reset-demo removes only demo-marked rows.
//   DATABASE_URL=<throwaway db> bun test test/meeting-eval/demo-kit.test.ts
import "../turn/env";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { resetGuard, describeDb, resetDemo } from "../../scripts/reset-demo";
import { buildDemo, seedDemoMeetings, seedGuard } from "../../scripts/seed-demo-meetings";
import { channels, commitments, meetings, users } from "../../src/db/schema";
import { db, resetDb } from "../db";
import { installFakes, removeFakes } from "../memory/helpers";
import { seedDemo } from "../../scripts/seed-demo";
import { entities, memories } from "../../src/db/schema";

const KEYS = ["id", "itemType", "title", "description", "assigneeId", "assigneeName", "dueDate", "priority", "kind", "label", "confidence", "reason", "quote", "evidence", "unverified", "followUp", "approval", "approvedBy", "approvedAt", "ambiguity", "commitmentId", "notification", "externalRefs"];
const AMB = ["ownerMissing", "ownerAmbiguous", "ownerCandidates", "dueMissing", "duplicateOf", "conflicts"];

beforeAll(resetDb);

describe("demo seed", () => {
  test("every item has the exact MeetingItem keys; the scripted states are all present", () => {
    const { meetings: ms, open } = buildDemo(Date.UTC(2026, 5, 3));
    const items = ms.flatMap((m) => m.items);
    for (const i of items) { expect(Object.keys(i).sort()).toEqual([...KEYS].sort()); expect(Object.keys(i.ambiguity).sort()).toEqual([...AMB].sort()); }
    expect(new Set(items.map((i) => i.approval))).toEqual(new Set(["proposed", "approved", "rejected"]));
    expect(new Set(items.map((i) => i.label))).toEqual(new Set(["confirmed", "tentative", "suggestion", "question"]));
    expect(items.some((i) => i.ambiguity.duplicateOf.length > 0) && items.some((i) => i.ambiguity.conflicts.some((c) => c.type === "due")) && items.some((i) => i.ambiguity.conflicts.some((c) => c.type === "owner"))).toBe(true);
    expect(items.some((i) => i.itemType === "task" && i.ambiguity.ownerMissing)).toBe(true);
    expect(ms.filter((m) => m.status === "ready")).toHaveLength(3);
    expect(ms.some((m) => m.status === "failed")).toBe(true);
    expect(open.some((c) => c.status === "overdue") && open.some((c) => c.due == null)).toBe(true);
  });
  test("is idempotent", async () => {
    const a = await seedDemoMeetings(Date.UTC(2026, 5, 3));
    const b = await seedDemoMeetings(Date.UTC(2026, 5, 4));
    expect(b).toEqual(a);
    expect((await db.select().from(meetings).where(like(meetings.sourceFileId, "demo:%")))).toHaveLength(4);
    expect((await db.select().from(commitments).where(like(commitments.sourceRef, "demo:%")))).toHaveLength(5);
  });
});

describe("reset", () => {
  test("guards", () => {
    expect(resetGuard(new Set())).toMatch(/--yes/);
    expect(resetGuard(new Set(["--yes"]), "production")).toMatch(/production/);
    expect(resetGuard(new Set(["--yes", "--force"]), "production")).toBeNull();
    expect(seedGuard(new Set(["--yes"]))).toBeNull();
    expect(describeDb("postgres://u:secret@db.example:5433/brain_x")).toBe("db.example:5433/brain_x");
    expect(describeDb("postgres://u:secret@db.example:5433/brain_x")).not.toContain("secret");
  });
  test("removes only demo-marked rows and reports counts", async () => {
    await db.insert(users).values({ id: "UREAL01", name: "Real Person", role: "member" });
    await db.insert(channels).values({ id: "CREAL01", name: "real", isPrivate: false });
    await db.insert(meetings).values({ id: "mt_real", sourceFileId: "ext:u1:meet:abc", channelId: "CREAL01", title: "Real meeting", transcript: "x", tasks: [], status: "ready" });
    await db.insert(commitments).values({ id: "cm_real", ownerId: "UREAL01", text: "Real task", sourceType: "meeting", sourceRef: "meeting:mt_real:0", scopeTag: "shared" });
    const dry = await resetDemo({ dryRun: true });
    expect(dry).toMatchObject({ meetings: 4, commitments: 5, users: 5, channels: 1 });
    expect((await db.select().from(meetings))).toHaveLength(5); // dry run deleted nothing
    const done = await resetDemo();
    expect(done).toEqual(dry);
    expect((await db.select({ id: meetings.id }).from(meetings)).map((m) => m.id)).toEqual(["mt_real"]);
    expect((await db.select({ id: commitments.id }).from(commitments)).map((c) => c.id)).toEqual(["cm_real"]);
    expect((await db.select().from(users).where(eq(users.id, "UREAL01")))).toHaveLength(1);
    expect((await db.select().from(channels).where(eq(channels.id, "CREAL01")))).toHaveLength(1);
    expect(await resetDemo()).toMatchObject({ meetings: 0, commitments: 0, memories: 0 }); // second run: nothing left
  });
  test("also removes the memories, entities and rows written by scripts/seed-demo.ts, not real facts", async () => {
    installFakes();
    try {
      const { addFact } = await import("../../src/memory/supersede");
      await addFact({ tag: "shared", text: "A real fact about Acme Corp.", source: "slack", entities: [{ name: "Acme Corp" }] });
      await seedDemo();
      expect((await db.select().from(memories)).length).toBeGreaterThan(30);
      const done = await resetDemo();
      expect(done.memories).toBeGreaterThan(30);
      expect((await db.select({ t: memories.text }).from(memories)).map((m) => m.t)).toEqual(["A real fact about Acme Corp."]);
      expect((await db.select({ n: entities.canonicalName }).from(entities)).map((e) => e.n)).toEqual(["Acme Corp"]);
    } finally { removeFakes(); }
  });
});
