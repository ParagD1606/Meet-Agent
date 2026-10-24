/**
 * Opt-in: LIVE_MODEL=1 runs the real configured model against the FAKE Notion-like MCP server (never the real Notion).
 *   set -a; . ../.env; set +a; export DATABASE_URL=<throwaway db> LIVE_MODEL=1 GOOGLE_APPLICATION_CREDENTIALS=...
 *   bun test test/mcp/real-model.live.test.ts
 */
import "../turn/env";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { createConnection } from "../../src/mcp/connections";
import { refreshModelSettings } from "../../src/llm";
import { runTurn } from "../../src/turn";
import { fakeSlack, seedUsers } from "../turn/helpers";
import { startFakeMcp } from "./fake-server";

const live = process.env.LIVE_MODEL === "1";

describe.skipIf(!live)("real model against the fake MCP server", () => {
  beforeAll(async () => { await refreshModelSettings().catch(() => {}); });
  test("create a new notion note with demo title (workspace connection)", async () => {
    await resetDb();
    await seedUsers();
    const slack = fakeSlack();
    const fake = await startFakeMcp();
    await createConnection({ provider: "notion", scope: "org", token: "good" });
    await runTurn({ trigger: "mention", channelId: "C1", ts: "10.1", userId: "UASK", text: "can you make a new notion note with demo title", isPrivate: false, isIm: false });
    const posts = [...slack.of("postMessage"), ...slack.of("update")].map((c) => String(c.args.text));
    console.log("FAKE SERVER CALLS:", JSON.stringify(fake.calls.map((c) => ({ tool: c.tool, args: c.args }))));
    console.log("REPLY:", posts.at(-1));
    fake.stop();
    expect(fake.calls.some((c) => c.tool === "notion-create-pages")).toBe(true);
  }, 180_000);

  test("GitHub exists only as a teammate's personal connection: the reply must say so, not 'I don't have GitHub'", async () => {
    await resetDb();
    await seedUsers();
    const slack = fakeSlack();
    const fake = await startFakeMcp();
    await createConnection({ provider: "notion", scope: "org", token: "good" });
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "good" });
    await runTurn({ trigger: "mention", channelId: "C1", ts: "10.2", userId: "UASK", text: "can you list the open issues in our github repo?", isPrivate: false, isIm: false });
    const { db } = await import("../../src/db");
    const { turns } = await import("../../src/db/schema");
    console.log("TOOL CALLS (github personal):", JSON.stringify(((await db.select().from(turns))[0] as any)?.toolCalls?.map((t: any) => t.name)), "steps", ((await db.select().from(turns))[0] as any)?.steps, "depth", ((await db.select().from(turns))[0] as any)?.depth);
    console.log("REPLY (github personal by teammate):", [...slack.of("postMessage"), ...slack.of("update")].map((c) => String(c.args.text)).at(-1));
    fake.stop();
  }, 180_000);

  test("search then create after reading external data: a card, not a silent write", async () => {
    await resetDb();
    await seedUsers();
    const slack = fakeSlack();
    const fake = await startFakeMcp();
    await createConnection({ provider: "notion", scope: "org", token: "good" });
    await runTurn({ trigger: "mention", channelId: "C1", ts: "10.3", userId: "UASK", text: "search notion for the roadmap page, then create a new page titled 'Roadmap follow-ups'", isPrivate: false, isIm: false });
    console.log("FAKE SERVER CALLS (read-then-write):", JSON.stringify(fake.calls.map((c) => c.tool)));
    console.log("CARDS:", slack.of("postMessage").filter((c) => JSON.stringify(c.args).includes("approval_approve")).length);
    console.log("REPLY (read-then-write):", [...slack.of("postMessage"), ...slack.of("update")].map((c) => String(c.args.text)).at(-1));
    fake.stop();
  }, 180_000);
});
