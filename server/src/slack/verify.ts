import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 60 * 5;

/** Slack v0 request signature check with a 5-minute replay window. Constant-time compare. */
export function verifySlackSignature(
  rawBody: Uint8Array | string,
  headers: Headers,
  signingSecret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const signature = headers.get("x-slack-signature");
  const timestamp = headers.get("x-slack-request-timestamp");
  if (!signature || !timestamp || !signingSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const isSlackRetry = (headers: Headers) => headers.get("x-slack-retry-num") != null;
