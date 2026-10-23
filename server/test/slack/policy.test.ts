import { beforeEach, describe, expect, test } from "bun:test";
import { addChannel, setup } from "./helpers";
import { db } from "../../src/db";
import { settings } from "../../src/db/schema";
import { evaluateBudget, reserveChime, CHIME_MAX_PER_HOUR, CHIME_MIN_GAP_MS } from "../../src/slack/chime-budget";
import { channelIsProactive, isProactive } from "../../src/slack/proactivity";
import { searchPeople } from "../../src/slack/people";
import { users } from "../../src/db/schema";

const MIN = 60_000;

describe("chime budget (pure)", () => {
  const now = 10_000_000_000;
  test("empty history allowed", () => expect(evaluateBudget([], now)).toEqual({ allowed: true }));
  test("min gap 5 minutes", () => {
    expect(evaluateBudget([now - 4 * MIN], now)).toEqual({ allowed: false, reason: "min_gap" });
    expect(evaluateBudget([now - CHIME_MIN_GAP_MS], now)).toEqual({ allowed: true });
  });
  test("3 per hour", () => {
    const three = [now - 50 * MIN, now - 30 * MIN, now - 10 * MIN];
    expect(evaluateBudget(three, now)).toEqual({ allowed: false, reason: "hourly_cap" });
    expect(evaluateBudget([now - 70 * MIN, now - 30 * MIN, now - 10 * MIN], now)).toEqual({ allowed: true });
  });
});

describe("chime budget (real Postgres)", () => {
  beforeEach(async () => { await setup(); });
  test("cap and gap enforced per channel; other channels independent", async () => {
    const t0 = new Date("2026-01-01T10:00:00Z");
    const at = (m: number) => new Date(t0.getTime() + m * MIN);
    expect((await reserveChime("C1", "1.1", at(0))).allowed).toBe(true);
    expect(await reserveChime("C1", "1.2", at(2))).toEqual({ allowed: false, reason: "min_gap" });
    expect((await reserveChime("C1", "1.3", at(6))).allowed).toBe(true);
    expect((await reserveChime("C1", "1.4", at(12))).allowed).toBe(true);
    expect(await reserveChime("C1", "1.5", at(20))).toEqual({ allowed: false, reason: "hourly_cap" });
    expect((await reserveChime("C2", "1.5", at(20))).allowed).toBe(true);
    expect((await reserveChime("C1", "1.6", at(61))).allowed).toBe(true); // first one aged out
    expect(CHIME_MAX_PER_HOUR).toBe(3);
  });
  test("concurrent reservations cannot both pass the gap", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveChime("CRACE", `r${i}`, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
  });
});

describe("proactivity policy", () => {
  const base = { isIm: false, botIsMember: true, isHome: false, override: "default" as const, orgDefault: "all" as const };
  test("pure precedence", () => {
    expect(isProactive(base)).toBe(true);
    expect(isProactive({ ...base, orgDefault: "own" })).toBe(false);
    expect(isProactive({ ...base, orgDefault: "own", isHome: true })).toBe(true);
    expect(isProactive({ ...base, orgDefault: "own", override: "proactive" })).toBe(true);
    expect(isProactive({ ...base, override: "quiet" })).toBe(false);
    expect(isProactive({ ...base, override: "quiet", isHome: true })).toBe(true); // home always proactive
    expect(isProactive({ ...base, botIsMember: false, isHome: true })).toBe(false); // must be a member
    expect(isProactive({ ...base, isIm: true })).toBe(false); // DMs never go through this gate
  });
  test("DB-backed: org default, overrides, home channel, unknown channel", async () => {
    await setup();
    await addChannel("CGEN");
    await addChannel("CQUIET", { proactivity: "quiet" });
    await addChannel("CNOTMEMBER", { botIsMember: false });
    await addChannel("CHOME", { name: "company-brain" });
    await addChannel("COPT", { proactivity: "proactive" });
    // pass-2 default is "own": only #company-brain speaks unprompted, every other channel is opt-in
    expect(await channelIsProactive("CGEN")).toBe(false);
    expect(await channelIsProactive("CHOME")).toBe(true);
    expect(await channelIsProactive("COPT")).toBe(true);
    expect(await channelIsProactive("CQUIET")).toBe(false);
    expect(await channelIsProactive("CNOTMEMBER")).toBe(false);
    expect(await channelIsProactive("CUNKNOWN")).toBe(false);
    await db.insert(settings).values({ key: "proactivity_default", value: "all" });
    expect(await channelIsProactive("CGEN")).toBe(true); // org-wide opt-in
    expect(await channelIsProactive("CQUIET")).toBe(false);
    await db.update(settings).set({ value: "garbage" });
    expect(await channelIsProactive("CGEN")).toBe(false); // junk falls back to "own"
  });
});

describe("people search", () => {
  test("matches name/email/title, excludes bots and deactivated, escapes LIKE", async () => {
    await setup();
    await db.insert(users).values([
      { id: "U1", name: "Priya Shah", email: "priya@acme.io", title: "Head of Billing" },
      { id: "U2", name: "Bot Priya", isBot: true },
      { id: "U3", name: "Priya Gone", deactivated: true },
      { id: "U4", name: "Sam", email: "sam@acme.io", title: "Eng" },
    ]);
    expect((await searchPeople("priya")).map((p) => p.id)).toEqual(["U1"]);
    expect((await searchPeople("billing")).map((p) => p.id)).toEqual(["U1"]);
    expect((await searchPeople("%")).length).toBe(0);
    expect((await searchPeople("  ")).length).toBe(0);
    expect((await searchPeople("u4")).map((p) => p.id)).toEqual(["U4"]);
  });
});
