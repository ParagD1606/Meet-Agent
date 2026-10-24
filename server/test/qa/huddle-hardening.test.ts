// QA M1/M4: huddle ingestion can't be steered into another channel's scope, or abused for cost.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { ingestHuddleFile, syncRecentHuddles } from "../../src/meetings";
import { setSlackClientForTest } from "../../src/slack/client";
import { db, resetDb } from "../db";
import { fakeVector, seedChannel } from "../memory/helpers";

const realFetch = globalThis.fetch;
beforeEach(async () => {
  await resetDb();
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(async (a) => a.system.includes("Slack Huddle source material") ? '{"summary":"Decisions: x.","tasks":[]}' : '{"facts":[]}');
  await seedChannel("CPUB", {});
  await seedChannel("CPRIV", { isPrivate: true });
});
afterEach(() => { globalThis.fetch = realFetch; setSlackClientForTest(null); setEmbedder(null); setMemoryLlm(null); });

const lines = (id: string, chans: string[]) => ({ id, title: id, channels: chans, huddle_transcription: { lines: [{ speaker_name: "Ana", text: `private notes ${id}` }] } });

test("a hint naming a public channel cannot relocate a private huddle's file", async () => {
  setSlackClientForTest({ files: { info: async () => ({ file: lines("F1", ["CPRIV"]) }) } });
  await ingestHuddleFile("F1", "CPUB");
  const [m] = await db.select().from(meetings).where(eq(meetings.sourceFileId, "F1"));
  expect(m!.channelId).toBe("CPRIV");
});

test("re-import never moves an existing meeting to another channel", async () => {
  setSlackClientForTest({ files: { info: async () => ({ file: { ...lines("F2", []), channels: undefined } }) } });
  await ingestHuddleFile("F2", "CPRIV");
  await ingestHuddleFile("F2", "CPUB");
  expect((await db.select().from(meetings).where(eq(meetings.sourceFileId, "F2")))[0]!.channelId).toBe("CPRIV");
});

test("a channel the bot is not in is skipped", async () => {
  await db.update((await import("../../src/db/schema")).channels).set({ botIsMember: false });
  setSlackClientForTest({ files: { info: async () => ({ file: lines("F3", ["CPUB"]) }) } });
  expect(await ingestHuddleFile("F3")).toBe(false);
  expect(await db.select().from(meetings)).toHaveLength(0);
});

test("sync is single-flight and capped per call", async () => {
  let listed = 0;
  const files = Array.from({ length: 30 }, (_, i) => lines(`G${i}`, ["CPUB"]));
  setSlackClientForTest({
    files: { list: async () => { listed++; await new Promise((r) => setTimeout(r, 20)); return { files, paging: { pages: 1 } }; }, info: async ({ file }: any) => ({ file: files.find((f) => f.id === file) }) },
  });
  const [a, b] = await Promise.all([syncRecentHuddles(), syncRecentHuddles()]);
  expect(listed).toBe(1);
  expect(a).toBe(b);
  expect(a.imported).toBe(20);
});

test("oversized canvas download is refused", async () => {
  setSlackClientForTest({ token: "xoxb", files: { info: async () => ({ file: { id: "F9", channels: ["CPUB"], url_private: "https://files.slack.com/x" } }) } });
  globalThis.fetch = (async () => new Response(new Uint8Array(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
  await expect(ingestHuddleFile("F9")).rejects.toThrow("too large");
});
