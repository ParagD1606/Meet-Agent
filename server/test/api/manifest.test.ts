import { describe, expect, test } from "bun:test";
import { slackAppManifest, slackManifestYaml, toYaml } from "../../src/routes/manifest";
import { config } from "../../src/config";
import { call, resetDb } from "./helpers";

describe("slack manifest", () => {
  test("http mode points every URL at PUBLIC_URL", () => {
    const m = slackAppManifest("https://brain.acme.io/", "http");
    expect(m.settings.event_subscriptions.request_url).toBe("https://brain.acme.io/slack/events");
    expect(m.settings.interactivity.request_url).toBe("https://brain.acme.io/slack/interactions");
    expect(m.oauth_config.redirect_urls).toEqual(["https://brain.acme.io/slack/oauth/callback", "https://brain.acme.io/auth/slack/callback"]);
    expect(m.settings.socket_mode_enabled).toBe(false);
    expect(m.oauth_config.scopes.user).toEqual(["openid", "profile", "email"]);
    expect(m.oauth_config.scopes.bot).toContain("app_mentions:read");
  });

  test("socket mode has no request URLs", () => {
    const m = slackAppManifest("https://brain.acme.io", "socket");
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions).not.toHaveProperty("request_url");
    expect(m.settings.interactivity).not.toHaveProperty("request_url");
  });

  test("yaml emitter produces parseable output (round-trips through Bun.YAML)", () => {
    const m = slackAppManifest("https://brain.acme.io", "http");
    const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(slackManifestYaml("https://brain.acme.io", "http"));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(m)));
    expect(toYaml({ a: [], b: { c: "x: y" }, d: [{ e: 1 }, "z"] })).toBe('a: []\nb:\n  c: "x: y"\nd:\n  -\n    e: 1\n  - "z"');
  });

  test("served by /api/setup/manifest using PUBLIC_URL", async () => {
    await resetDb();
    config.PUBLIC_URL = "https://brain.example.org";
    config.SLACK_MODE = "http";
    const res = await call("GET", "/api/setup/manifest");
    expect(res.headers.get("content-type")).toContain("yaml");
    expect(await res.text()).toContain("https://brain.example.org/slack/events");
    config.PUBLIC_URL = "http://localhost:3000";
    config.SLACK_MODE = "socket";
  });
});
