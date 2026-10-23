import { beforeEach, describe, expect, test } from "bun:test";
import { setup } from "./helpers";
import { extractFile, readSlackFiles, type Fetcher } from "../../src/slack/attachments";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
beforeEach(async () => { await setup(); });

describe("extractFile", () => {
  test("text, csv by extension, images noted, unknown noted", async () => {
    expect((await extractFile("a.txt", "text/plain", enc("hello"))).text).toBe("hello");
    expect((await extractFile("a.csv", "application/octet-stream", enc("a,b"))).text).toBe("a,b");
    expect((await extractFile("p.png", "image/png", enc(""))).text).toContain("image");
    expect((await extractFile("x.bin", "application/zip", enc(""))).text).toContain("unsupported");
  });
  test("truncates huge text", async () => {
    const r = await extractFile("big.txt", "text/plain", enc("x".repeat(150_000)));
    expect(r.text.length).toBeLessThan(100_100);
    expect(r.text).toEndWith("[truncated]");
  });
});

describe("readSlackFiles", () => {
  test("sends the decrypted bot token, returns text; failures become notes and never throw", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (url, token) => {
      seen.push(`${url}|${token}`);
      if (url.includes("bad")) return { ok: false, status: 403, contentType: "text/plain", body: enc("") };
      if (url.includes("login")) return { ok: true, status: 200, contentType: "text/html", body: enc("<html>") };
      if (url.includes("boom")) throw new Error("network");
      return { ok: true, status: 200, contentType: "text/plain", body: enc("notes") };
    };
    const out = await readSlackFiles([
      { name: "ok.txt", mimetype: "text/plain", url_private_download: "https://f/ok" },
      { name: "bad.txt", mimetype: "text/plain", url_private_download: "https://f/bad" },
      { name: "login.pdf", mimetype: "application/pdf", url_private_download: "https://f/login" },
      { name: "boom.txt", mimetype: "text/plain", url_private_download: "https://f/boom" },
      { name: "huge.txt", mimetype: "text/plain", size: 99e6, url_private_download: "https://f/huge" },
    ], fetcher);
    expect(out.map((o) => o.text)).toEqual([
      "notes", "[download failed: HTTP 403]", expect.stringContaining("login page"), "[could not read this file]",
      expect.stringContaining("too large"),
    ]);
    expect(seen[0]).toBe("https://f/ok|xoxb-test");
    expect(seen.some((s) => s.includes("huge"))).toBe(false);
  });
  test("images are never downloaded", async () => {
    const out = await readSlackFiles([{ name: "p.png", mimetype: "image/png", url_private_download: "https://f/p" }], async () => { throw new Error("must not fetch"); });
    expect(out[0]!.text).toContain("image");
  });
  test("no files => empty", async () => expect(await readSlackFiles(undefined)).toEqual([]));
});
