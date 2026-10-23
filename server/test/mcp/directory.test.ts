import "../turn/env";
import { describe, expect, test } from "bun:test";
import { MARKET, searchDirectory, validateCustomMcpUrl } from "../../src/mcp/directory";
import raw from "../../src/mcp/directory.json";

describe("directory catalog", () => {
  test("is valid: https only, unique keys, no private hosts, trimmed size", () => {
    expect(raw.entries.length).toBeLessThanOrEqual(200);
    expect(new Set(MARKET.map((m) => m.key)).size).toBe(MARKET.length);
    for (const m of MARKET) {
      const u = new URL(m.url);
      expect(u.protocol).toBe("https:");
      expect(u.username).toBe("");
      expect(/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)).toBe(false);
    }
  });

  test("presets come first and are marked curated; personal-only is preserved", () => {
    expect(MARKET[0]!.curated).toBe(true);
    expect(MARKET.find((m) => m.key === "gmail-personal-only")!.personalOnly).toBe(true);
  });

  test("search ranks exact name above category and returns totals", () => {
    const r = searchDirectory("figma");
    expect(r.apps[0]!.name.toLowerCase()).toContain("figma");
    const broad = searchDirectory("productivity", 3);
    expect(broad.apps).toHaveLength(3);
    expect(broad.truncated).toBe(true);
    expect(broad.totalMatches).toBeGreaterThan(3);
    expect(searchDirectory("zzzz-nothing").apps).toEqual([]);
    expect(searchDirectory("").apps.length).toBe(10); // empty = most popular
  });

  test("custom URL validation rejects non-https, credentials, private and local hosts", async () => {
    for (const bad of ["not a url", "http://example.com/mcp", "https://user:pw@example.com/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp", "https://169.254.169.254/x", "https://10.1.2.3/mcp", "https://[::1]/mcp", "https://svc.internal/mcp"]) {
      expect((await validateCustomMcpUrl(bad)).ok).toBe(false);
    }
  });
});
