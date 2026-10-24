import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { addChannel, evt, nextTs, setup } from "./helpers";
import { db } from "../../src/db";
import { events } from "../../src/db/schema";
import { handleEventCallback } from "../../src/slack/events";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

const fresh = () => ctx.fake.calls.filter((c) => c.method === "chat.postMessage" && /Fresh start/.test(String(c.args.text)));

describe("message claim: released when processing throws", () => {
  test("a throw before the work is done gives the claim back so Slack's retry is processed; a success keeps it", async () => {
    await addChannel("D1", { isIm: true });
    const m = { type: "message", user: "U1", text: "new chat", ts: nextTs(), channel: "D1", channel_type: "im" };
    const key = `m:D1:${m.ts}`;
    await db.execute(sql`alter table thread_state rename to thread_state_x`); // makes the reset write throw
    try { await handleEventCallback(evt(m)).catch(() => {}); } finally { await db.execute(sql`alter table thread_state_x rename to thread_state`); }
    expect(await db.select().from(events).where(eq(events.id, key))).toHaveLength(0);
    expect(fresh()).toHaveLength(0);
    await handleEventCallback(evt(m)); // Slack's retry (new event_id, same message)
    expect(await db.select().from(events).where(eq(events.id, key))).toHaveLength(1);
    expect(fresh()).toHaveLength(1);
    await handleEventCallback(evt(m)); // redelivery after success is a duplicate
    expect(fresh()).toHaveLength(1);
  });
});
