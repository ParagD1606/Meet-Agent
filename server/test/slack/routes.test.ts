import { beforeEach, describe, expect, test } from "bun:test";
import { setup } from "./helpers";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { mountSlack } from "../../src/slack";
import { checkState, makeState } from "../../src/slack/install";
import { db } from "../../src/db";
import { events } from "../../src/db/schema";

const secret = "test-signing-secret";
const signed = (body: string, ts = Math.floor(Date.now() / 1000), key = secret) => ({
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex")}`,
});
const app = new Hono();
mountSlack(app);
let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

describe("POST /slack/events", () => {
  test("rejects unsigned, bad-signature and stale requests", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    expect((await app.request("/slack/events", { method: "POST", body })).status).toBe(401);
    expect((await app.request("/slack/events", { method: "POST", body, headers: signed(body, undefined, "wrong") })).status).toBe(401);
    expect((await app.request("/slack/events", { method: "POST", body, headers: signed(body, Math.floor(Date.now() / 1000) - 600) })).status).toBe(401);
  });
  test("answers url_verification when signed", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await app.request("/slack/events", { method: "POST", body, headers: signed(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc" });
  });
  test("acks event_callback immediately and processes it in the background; retries are not reprocessed", async () => {
    const body = JSON.stringify({ type: "event_callback", event_id: "EvR1", team_id: "T1", event: { type: "message", user: "U1", text: "<@UBOT> hi", ts: "1.1", channel: "D1", channel_type: "im" } });
    const res = await app.request("/slack/events", { method: "POST", body, headers: signed(body) });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && !ctx.turns.length; i++) await Bun.sleep(20);
    expect(ctx.turns).toHaveLength(1);
    await app.request("/slack/events", { method: "POST", body, headers: { ...signed(body), "x-slack-retry-num": "1" } });
    await Bun.sleep(50);
    expect(ctx.turns).toHaveLength(1);
    expect((await db.select().from(events)).length).toBeGreaterThan(0);
  });
  test("malformed JSON with a valid signature => 400", async () => {
    const body = "{nope";
    expect((await app.request("/slack/events", { method: "POST", body, headers: signed(body) })).status).toBe(400);
  });
});

describe("POST /slack/interactions", () => {
  test("verifies signature, forwards payload to the turn module", async () => {
    const payload = JSON.stringify({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "approval_approve", value: "x" }] });
    const body = "payload=" + encodeURIComponent(payload);
    expect((await app.request("/slack/interactions", { method: "POST", body })).status).toBe(401);
    const res = await app.request("/slack/interactions", { method: "POST", body, headers: { ...signed(body), "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && !ctx.blockActions.length; i++) await Bun.sleep(20);
    expect(ctx.blockActions).toHaveLength(1);
  });
});

describe("OAuth install", () => {
  test("state is signed, bound to the cookie nonce, and expires", () => {
    const { state, nonce } = makeState(1000);
    expect(checkState(state, nonce, 2000)).toBe(true);
    expect(checkState(state, "other", 2000)).toBe(false);
    expect(checkState(state + "x", nonce, 2000)).toBe(false);
    expect(checkState(state, nonce, 1000 + 11 * 60_000)).toBe(false);
    expect(checkState(undefined, nonce)).toBe(false);
  });
  test("/slack/install redirects to Slack with scopes + state and sets the cookie", async () => {
    const res = await app.request("/slack/install");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("scope")).toContain("chat:write");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });
  test("callback rejects missing/forged state without calling Slack", async () => {
    expect((await app.request("/slack/oauth/callback?code=x&state=bad")).status).toBe(400);
    expect((await app.request("/slack/oauth/callback?error=access_denied")).status).toBe(400);
  });
});
