import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { episodes, memories } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { rememberMeeting } from "../../src/meetings";
import { db, resetDb } from "../db";
import { fakeVector, seedChannel } from "../memory/helpers";

beforeEach(async () => {
  await resetDb();
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(async (a) => (a.system.includes("durable company knowledge")
    ? '{"facts":["The team decided to ship the billing rewrite in November."]}'
    : a.system.includes("superseded") ? '{"superseded":[]}' : "Huddle summary: the team agreed to ship the billing rewrite in November and Ana owns the migration."));
});
afterEach(() => { setEmbedder(null); setMemoryLlm(null); });

const meeting = { fileId: "F1", title: "Billing sync", summary: "Decisions: ship billing rewrite in November. ".repeat(4), tasks: [{ title: "Write migration", assigneeName: "Ana", dueDate: "2026-11-01" }] };

test("public channel meeting becomes shared facts + episode", async () => {
  await seedChannel("C1", {});
  await rememberMeeting({ channelId: "C1", ...meeting });
  expect((await db.select().from(memories).where(eq(memories.scopeTag, "shared"))).length).toBeGreaterThan(0);
  expect((await db.select().from(episodes))[0]!.scopeTag).toBe("shared");
});

test("private channel meeting stays in channel scope", async () => {
  await seedChannel("C2", { isPrivate: true });
  await rememberMeeting({ channelId: "C2", ...meeting });
  expect((await db.select().from(memories).where(eq(memories.scopeTag, "shared"))).length).toBe(0);
  expect((await db.select().from(episodes))[0]!.scopeTag).toBe("channel_C2");
});

test("unknown channel is treated as private", async () => {
  await rememberMeeting({ channelId: "CX", ...meeting });
  expect((await db.select().from(episodes))[0]!.scopeTag).toBe("channel_CX");
});
