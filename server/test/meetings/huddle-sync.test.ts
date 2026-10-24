import { afterEach, beforeEach, expect, test } from "bun:test";
import { syncRecentHuddles } from "../../src/meetings";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { db, resetDb } from "../db";
import { meetings } from "../../src/db/schema";
import { fakeVector, seedChannel } from "../memory/helpers";

const huddle = (id: string) => ({ id, title: id, channels: ["C1"], huddle_transcript_file_id: "T" + id });
const withLines = (id: string) => ({ id, title: id, channels: ["C1"], huddle_transcription: { lines: [{ speaker_name: "Ana", text: `notes ${id}` }] } });
let listCalls: number[];
let infoCalls: string[];
beforeEach(async () => {
  await resetDb();
  listCalls = []; infoCalls = [];
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(async (a) => a.system.includes("Slack Huddle source material") ? '{"summary":"s","tasks":[]}' : a.system.includes("durable company knowledge") ? '{"facts":[]}' : '{"superseded":[]}');
  await seedChannel("C1", {});
  setSlackClientForTest({
    files: {
      list: async (a: { page: number }) => { listCalls.push(a.page); return { files: a.page === 1 ? [huddle("H1")] : [huddle("H2")], paging: { pages: 2 } }; },
      info: async (a: { file: string }) => { infoCalls.push(a.file); return { file: a.file.startsWith("T") ? withLines(a.file) : huddle(a.file) }; },
    },
  });
});
afterEach(() => { setSlackClientForTest(null); setEmbedder(null); setMemoryLlm(null); });

test("walks every files.list page and skips meetings that are already imported", async () => {
  expect(await syncRecentHuddles()).toMatchObject({ found: 2, imported: 2, failed: 0 });
  expect(listCalls).toEqual([1, 2]);
  expect((await db.select().from(meetings)).length).toBe(2);
  infoCalls = [];
  expect(await syncRecentHuddles()).toMatchObject({ found: 2, imported: 0 }); // second run: nothing re-summarized
  expect(infoCalls).toEqual([]);
  expect(await syncRecentHuddles({ force: true })).toMatchObject({ imported: 2 });
});
