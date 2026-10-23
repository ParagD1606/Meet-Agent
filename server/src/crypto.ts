import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config";

const key = () => {
  if (!config.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required");
  const k = Buffer.from(config.ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes base64");
  return k;
};

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const id = (prefix = "") => prefix + randomBytes(12).toString("base64url");
