import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { meetings } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { ingestHuddleFile } from "../../src/meetings";
import { setSlackClientForTest } from "../../src/slack/client";
import { db, resetDb } from "../db";
import { fakeVector, seedChannel } from "../memory/helpers";

const realFetch = globalThis.fetch;
let fetched: { url: string; auth: string | null }[];
beforeEach(async () => {
  await resetDb();
  fetched = [];
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(async (a) => a.system.includes("Slack Huddle source material")
    ? '{"summary":"Decisions: ship in November.","tasks":[]}'
    : a.system.includes("durable company knowledge") ? '{"facts":[]}' : '{"superseded":[]}');
  await seedChannel("C1", {});
});
afterEach(() => { globalThis.fetch = realFetch; setSlackClientForTest(null); setEmbedder(null); setMemoryLlm(null); });

const files: Record<string, any> = {
  FNOTES: { id: "FNOTES", title: "Huddle notes", filetype: "quip", huddle_transcript_file_id: "FTR", channels: ["C1"] },
  FTR: { id: "FTR", title: "Huddle transcript", filetype: "quip", url_private_download: "https://files.slack.com/files-pri/T-FTR/download/t.html" },
};
const client = (info: (a: { file: string }) => unknown) => setSlackClientForTest({ token: "xoxb-bot", files: { info: async (a: { file: string }) => info(a) } });

test("downloads the transcript canvas (following Slack redirects with auth) when no inline lines exist", async () => {
  client(({ file }) => ({ file: files[file] }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    fetched.push({ url: u.toString(), auth: null });
    if (u.pathname.includes("/download/")) return new Response(null, { status: 302, headers: { location: "https://slack-files.com/final" } });
    return new Response("<html><body><p><b>Ana</b> 0:05</p><p>Let&#39;s ship in November</p></body></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  expect(await ingestHuddleFile("FNOTES")).toBe(true);
  expect(fetched.map((f) => new URL(f.url).host)).toEqual(["files.slack.com", "slack-files.com"]);
  const [m] = await db.select().from(meetings).where(eq(meetings.sourceFileId, "FTR"));
  expect(m!.transcript).toContain("Ana");
  expect(m!.transcript).toContain("Let's ship in November");
  expect(m!.status).toBe("ready");
});

test("never sends the token to a non-Slack host", async () => {
  client(() => ({ file: { id: "F", url_private: "https://evil.example.com/x", channels: ["C1"] } }));
  let hit = false;
  globalThis.fetch = (async () => { hit = true; return new Response("x"); }) as unknown as typeof fetch;
  await expect(ingestHuddleFile("F")).rejects.toThrow("non-Slack host");
  expect(hit).toBe(false);
});

test("missing_scope surfaces the needed scope", async () => {
  client(() => { throw Object.assign(new Error("platform"), { data: { error: "missing_scope", needed: "files:read", provided: "chat:write" } }); });
  await expect(ingestHuddleFile("F")).rejects.toThrow('"files:read"');
});
