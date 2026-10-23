import "./env";
import { describe, expect, test } from "bun:test";
import { assertConfig, config, configProblems, type Config } from "../../src/config";
import { redactError } from "../../src/log";

const good: Config = {
  ...config, NODE_ENV: "production", ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), PUBLIC_URL: "https://brain.example.com",
  SLACK_MODE: "http", SLACK_SIGNING_SECRET: "s", EMBEDDING_API_KEY: "k", EMBEDDING_BASE_URL: undefined, EMBEDDING_DIM: 1536,
};

describe("production config fail-fast", () => {
  test("a good config has no problems", () => expect(configProblems(good)).toEqual([]));
  test("bad encryption key length", () => expect(configProblems({ ...good, ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }).join()).toMatch(/32 bytes/));
  test("missing key", () => expect(configProblems({ ...good, ENCRYPTION_KEY: undefined }).join()).toMatch(/ENCRYPTION_KEY/));
  test("http PUBLIC_URL", () => expect(configProblems({ ...good, PUBLIC_URL: "http://x.com" }).join()).toMatch(/https/));
  test("signing secret required in http mode", () => expect(configProblems({ ...good, SLACK_SIGNING_SECRET: undefined }).join()).toMatch(/SIGNING_SECRET/));
  test("EMBEDDING_DIM above pgvector's index limit (also outside production)", () => {
    expect(configProblems({ ...good, EMBEDDING_DIM: 3072 }).join()).toMatch(/2000/);
    expect(configProblems({ ...good, EMBEDDING_DIM: 3072 }, false).join()).toMatch(/2000/);
  });
  test("embedding key required unless a base URL is set", () => {
    expect(configProblems({ ...good, EMBEDDING_API_KEY: undefined }).join()).toMatch(/EMBEDDING_API_KEY/);
    expect(configProblems({ ...good, EMBEDDING_API_KEY: undefined, EMBEDDING_BASE_URL: "http://localhost:11434/v1" })).toEqual([]);
  });
  test("dev is lenient; assertConfig throws one error listing everything", () => {
    expect(configProblems({ ...good, PUBLIC_URL: "http://x", ENCRYPTION_KEY: undefined }, false)).toEqual([]);
    expect(() => assertConfig({ ...good, PUBLIC_URL: "http://x", ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY[\s\S]*https/);
  });
});

describe("redacted error logging", () => {
  test("strips query strings, credentials, vectors, bearer tokens and extra lines", () => {
    const vec = `[${Array.from({ length: 50 }, (_, i) => (i / 7).toFixed(4)).join(",")}]`;
    const out = redactError(new Error(`GET https://api.example.com/x?token=abc&q=secret failed\nparams: ${vec}`));
    expect(out).not.toContain("secret");
    expect(out).toContain("?[redacted]");
    expect(out).not.toContain("params");
    expect(redactError(`insert ... values ($1) ${vec}`)).toContain("[vector redacted]");
    expect(redactError("postgres://user:hunter2@db/x")).not.toContain("hunter2");
    expect(redactError("Authorization: Bearer abcdefghijklmnop12345")).not.toContain("abcdefghijklmnop12345");
  });
});
