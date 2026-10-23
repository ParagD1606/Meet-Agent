import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isSlackRetry, verifySlackSignature } from "../../src/slack/verify";

const secret = "s3cret";
const sign = (body: string, ts: number) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
const hdr = (sig: string, ts: number | string) => new Headers({ "x-slack-signature": sig, "x-slack-request-timestamp": String(ts) });
const NOW = 1_700_000_000;

describe("verifySlackSignature", () => {
  const body = '{"type":"event_callback"}';
  test("accepts a valid signature (string and bytes)", () => {
    expect(verifySlackSignature(body, hdr(sign(body, NOW), NOW), secret, NOW)).toBe(true);
    expect(verifySlackSignature(new TextEncoder().encode(body), hdr(sign(body, NOW), NOW), secret, NOW + 10)).toBe(true);
  });
  test("rejects tampered body, wrong secret, missing headers, garbage timestamp", () => {
    expect(verifySlackSignature(body + " ", hdr(sign(body, NOW), NOW), secret, NOW)).toBe(false);
    expect(verifySlackSignature(body, hdr(sign(body, NOW), NOW), "other", NOW)).toBe(false);
    expect(verifySlackSignature(body, new Headers(), secret, NOW)).toBe(false);
    expect(verifySlackSignature(body, hdr(sign(body, NOW), "abc"), secret, NOW)).toBe(false);
    expect(verifySlackSignature(body, hdr("v0=short", NOW), secret, NOW)).toBe(false);
  });
  test("5-minute replay window, both directions, boundary inclusive", () => {
    const h = hdr(sign(body, NOW), NOW);
    expect(verifySlackSignature(body, h, secret, NOW + 300)).toBe(true);
    expect(verifySlackSignature(body, h, secret, NOW + 301)).toBe(false);
    expect(verifySlackSignature(body, h, secret, NOW - 301)).toBe(false);
  });
  test("unset signing secret never verifies", () => {
    expect(verifySlackSignature(body, hdr(sign(body, NOW), NOW), undefined, NOW)).toBe(false);
    expect(verifySlackSignature(body, hdr(createHmac("sha256", "").update(`v0:${NOW}:${body}`).digest("hex"), NOW), "", NOW)).toBe(false);
  });
  test("retry header detection", () => {
    expect(isSlackRetry(new Headers({ "x-slack-retry-num": "1" }))).toBe(true);
    expect(isSlackRetry(new Headers())).toBe(false);
  });
});
