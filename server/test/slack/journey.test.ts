import { beforeEach, describe, expect, test } from "bun:test";
import { setup } from "./helpers";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { automations, journeyState, mcpConnections, turns, users } from "../../src/db/schema";
import { decideNudge, MAX_NUDGES_PER_RUNG, MIN_NUDGE_GAP_MS } from "../../src/slack/journey/guardrails";
import { journeyTick, nudgeUser, setJourneyQuiet, startJourney } from "../../src/slack/journey";
import { onUserJoined } from "../../src/slack/onboarding";

const none = { connect_tool: false, first_ask: false, automation: false };
const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = MIN_NUDGE_GAP_MS;

describe("decideNudge (pure guardrails)", () => {
  test("offers the lowest ungranted rung", () => {
    expect(decideNudge({}, none, NOW)).toEqual({ action: "send", rung: "connect_tool" });
    expect(decideNudge({}, { ...none, connect_tool: true }, NOW)).toEqual({ action: "send", rung: "first_ask" });
  });
  test("max one nudge per day", () => {
    const last = new Date(NOW - DAY + 1000).toISOString();
    expect(decideNudge({ lastNudgeAt: last }, none, NOW)).toEqual({ action: "suppress", reason: "rate_limited" });
    expect(decideNudge({ lastNudgeAt: new Date(NOW - DAY).toISOString() }, none, NOW).action).toBe("send");
  });
  test("quiet and exited users are never nudged", () => {
    expect(decideNudge({ quiet: true }, none, NOW)).toEqual({ action: "suppress", reason: "quiet" });
    expect(decideNudge({ exited: "completed" }, none, NOW)).toEqual({ action: "suppress", reason: "exited" });
  });
  test("completed ladder exits; ignored rung is skipped, all ignored exits", () => {
    expect(decideNudge({}, { connect_tool: true, first_ask: true, automation: true }, NOW)).toEqual({ action: "exit", reason: "completed" });
    expect(decideNudge({ nudges: { connect_tool: MAX_NUDGES_PER_RUNG } }, none, NOW)).toEqual({ action: "send", rung: "first_ask" });
    expect(decideNudge({ nudges: { connect_tool: 2, first_ask: 2, automation: 2 } }, none, NOW)).toEqual({ action: "exit", reason: "ignored" });
  });
});

describe("journey engine (real Postgres)", () => {
  let sent: string[];
  const send = async (u: string, r: string) => { sent.push(`${u}:${r}`); return true; };
  beforeEach(async () => { await setup(); sent = []; });

  test("startJourney is idempotent (welcome fires once)", async () => {
    expect(await startJourney("U1")).toBe(true);
    expect(await startJourney("U1")).toBe(false);
  });

  test("day-1 welcome counts as the day's nudge; next day sends the first rung; then waits a day", async () => {
    const t0 = new Date(NOW);
    await startJourney("U1", t0);
    expect((await nudgeUser("U1", NOW + 3600_000, send)).action).toBe("suppress");
    expect((await nudgeUser("U1", NOW + DAY + 1, send)).action).toBe("send");
    expect(sent).toEqual(["U1:connect_tool"]);
    expect((await nudgeUser("U1", NOW + DAY + 2, send)).action).toBe("suppress");
    expect(sent).toHaveLength(1);
  });

  test("progress is read live: acting on the tool advances the ladder; two ignored asks skip the rung", async () => {
    await startJourney("U1", new Date(NOW));
    let t = NOW + DAY + 1;
    await nudgeUser("U1", t, send); t += DAY;
    await nudgeUser("U1", t, send); t += DAY; // second connect_tool ask
    await nudgeUser("U1", t, send); t += DAY; // connect_tool exhausted -> first_ask
    expect(sent).toEqual(["U1:connect_tool", "U1:connect_tool", "U1:first_ask"]);
    await db.insert(turns).values({ id: "t1", channelId: "D1", userId: "U1", trigger: "dm" });
    await nudgeUser("U1", t, send);
    expect(sent.at(-1)).toBe("U1:automation");
  });

  test("completing everything exits; failed send is not counted; quiet stops it", async () => {
    await startJourney("U2", new Date(NOW));
    await db.insert(mcpConnections).values({ id: "c1", provider: "github", label: "gh", url: "https://x", scope: "user", ownerUserId: "U2", status: "connected" });
    await db.insert(turns).values({ id: "t2", channelId: "D1", userId: "U2", trigger: "mention" });
    await db.insert(automations).values({ id: "a1", ownerUserId: "U2", kind: "digest", prompt: "p", cron: "0 9 * * 1" });
    expect(await nudgeUser("U2", NOW + DAY + 1, send)).toEqual({ action: "exit", reason: "completed" });
    expect(sent).toHaveLength(0);
    expect((await db.select().from(journeyState).where(eq(journeyState.userId, "U2")))[0]).toMatchObject({ rung: 3, data: { exited: "completed" } });

    await startJourney("U3", new Date(NOW));
    expect((await nudgeUser("U3", NOW + DAY + 1, async () => false)).action).toBe("send");
    expect((await db.select().from(journeyState).where(eq(journeyState.userId, "U3")))[0]!.data).not.toHaveProperty("nudges");
    await setJourneyQuiet("U3");
    expect((await nudgeUser("U3", NOW + 5 * DAY, send)).action).toBe("suppress");
  });

  test("journeyTick sweeps eligible humans only and survives per-user failures", async () => {
    await db.insert(users).values([{ id: "UA", name: "A" }, { id: "UB", name: "B", isBot: true }, { id: "UC", name: "C", deactivated: true }]);
    for (const u of ["UA", "UB", "UC"]) await startJourney(u, new Date(NOW));
    const r = await journeyTick(NOW + DAY + 1); // real send => fake slack not installed in this describe -> postDm fails safely
    expect(r.checked).toBe(1);
  });

  test("onUserJoined sends welcome once via Slack", async () => {
    const { fake } = await setup();
    await onUserJoined("U9");
    await onUserJoined("U9");
    expect(fake.count("chat.postMessage")).toBe(1);
    expect(fake.calls.find((c) => c.method === "chat.postMessage")!.args.channel).toBe("D_U9");
  });
});
