import "./env";
import { afterEach, describe, expect, test } from "bun:test";
import { guardedFetch, setResolver } from "../../src/tools/web/ssrf";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setResolver(undefined); });

const DNS: Record<string, string[]> = {
  "good.example": ["93.184.216.34"],
  "mixed.example": ["93.184.216.34", "10.0.0.5"],
  "rebind.example": ["169.254.169.254"],
  "other.example": ["93.184.216.35"],
};
const seen: string[] = [];
function mock(routes: Record<string, () => Response>) {
  setResolver(async (h) => DNS[h] ?? []);
  seen.length = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const u = String(input);
    seen.push(`${init?.redirect}:${u}:${new Headers(init?.headers).get("authorization") ?? ""}`);
    const r = routes[u];
    if (!r) throw new Error(`unexpected fetch ${u}`);
    return r();
  }) as typeof fetch;
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("guardedFetch (MCP transport + OAuth calls)", () => {
  test("plain public fetch works and never lets fetch follow redirects itself", async () => {
    mock({ "https://good.example/mcp": () => new Response("ok") });
    const r = await guardedFetch("https://good.example/mcp");
    expect(await r.text()).toBe("ok");
    expect(seen[0]).toStartWith("manual:");
  });
  test("literal private/metadata/loopback targets never reach fetch", async () => {
    mock({});
    for (const u of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/", "http://[::1]/", "http://10.1.1.1/", "file:///etc/passwd", "http://localhost/"]) {
      await expect(guardedFetch(u)).rejects.toThrow();
    }
    expect(seen).toHaveLength(0);
  });
  test("a host resolving to ANY private address is refused (mixed answer)", async () => {
    mock({});
    await expect(guardedFetch("https://mixed.example/")).rejects.toThrow(/private/);
    expect(seen).toHaveLength(0);
  });
  test("redirect to a private literal is blocked at the hop, after the first request", async () => {
    mock({ "https://good.example/a": redirect("http://169.254.169.254/latest/meta-data/") });
    await expect(guardedFetch("https://good.example/a")).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
  test("redirect to a hostname whose DNS now points inside is blocked (rebinding via redirect)", async () => {
    mock({ "https://good.example/a": redirect("https://rebind.example/x") });
    await expect(guardedFetch("https://good.example/a")).rejects.toThrow(/private/);
    expect(seen).toHaveLength(1);
  });
  test("DNS answers are re-checked on every hop (public first, private on the next lookup)", async () => {
    let n = 0;
    mock({ "https://flip.example/a": redirect("https://flip.example/b"), "https://flip.example/b": () => new Response("leak") });
    setResolver(async () => (n++ === 0 ? ["93.184.216.34"] : ["10.0.0.9"]));
    await expect(guardedFetch("https://flip.example/a")).rejects.toThrow(/private/);
    expect(seen).toHaveLength(1);
  });
  test("public redirect chains are followed; credentials do not cross origins; POST becomes GET on 303", async () => {
    mock({
      "https://good.example/a": redirect("https://other.example/b", 303),
      "https://other.example/b": () => new Response("done"),
    });
    const r = await guardedFetch("https://good.example/a", { method: "POST", body: "x", headers: { authorization: "Bearer s3cret" } });
    expect(await r.text()).toBe("done");
    expect(seen[0]).toContain("Bearer s3cret");
    expect(seen[1]).not.toContain("s3cret");
  });
  test("redirect loops are capped", async () => {
    mock({ "https://good.example/a": redirect("https://good.example/a") });
    await expect(guardedFetch("https://good.example/a")).rejects.toThrow(/too many redirects/);
  });
});
