import "./env";
import { describe, expect, test } from "bun:test";
import { extractUrl, htmlToText } from "../../src/tools/web/extract";
import { assertPublicUrl, isPrivateIp, safeFetch } from "../../src/tools/web/ssrf";

describe("isPrivateIp", () => {
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1",
  ])("%s is blocked", (ip) => expect(isPrivateIp(ip)).toBe(true));
  test.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"])("%s is allowed", (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  test.each([
    "http://localhost/x", "http://127.0.0.1:8080", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/",
    "http://0x7f.0.0.1/", "http://2130706433/", "file:///etc/passwd", "ftp://example.com", "http://user:pw@8.8.8.8/", "http://foo.internal/", "not a url",
  ])("rejects %s", async (u) => { await expect(assertPublicUrl(u)).rejects.toThrow(); });
  test("accepts a public literal IP", async () => { expect((await assertPublicUrl("https://8.8.8.8/x")).hostname).toBe("8.8.8.8"); });
  test("rejects hostnames that resolve to loopback", async () => { await expect(assertPublicUrl("http://localtest.me/")).rejects.toThrow(); });
});

describe("fetching", () => {
  test("extractUrl refuses a live local server (no request is made)", async () => {
    let hit = false;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hit = true; return new Response("secret"); } });
    try {
      await expect(extractUrl(`http://127.0.0.1:${srv.port}/`)).rejects.toThrow(/private|blocked/);
      await expect(safeFetch(`http://localhost:${srv.port}/`)).rejects.toThrow();
      expect(hit).toBe(false);
    } finally { srv.stop(true); }
  });
});

describe("htmlToText", () => {
  test("keeps article content, drops scripts/nav, decodes entities", () => {
    const { title, text } = htmlToText(`<html><head><title>Hi &amp; bye</title><script>evil()</script></head><body><nav>menu</nav><article><h1>Head</h1><p>One &lt;two&gt;</p><ul><li>a</li></ul></article><footer>f</footer></body></html>`);
    expect(title).toBe("Hi & bye");
    expect(text).toContain("# Head");
    expect(text).toContain("One <two>");
    expect(text).toContain("- a");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("menu");
  });
});
