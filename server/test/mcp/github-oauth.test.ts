import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { resetDb } from "../db";
import { config } from "../../src/config";
import { createConnection, makeWorkspaceWide } from "../../src/mcp/connections";
import { startGithubConnect } from "../../src/mcp/github";
import { readAuth } from "../../src/mcp/oauth";
import { seedUsers } from "../turn/helpers";
import { mountMcp } from "../../src/mcp";

beforeEach(async () => {
  await resetDb();
  await seedUsers();
  Object.assign(config, { PUBLIC_URL: "https://brain.example", GITHUB_APP_CLIENT_ID: "Iv1_test", GITHUB_APP_CLIENT_SECRET: "test-secret" });
});

describe("GitHub App user OAuth", () => {
  test("direct GitHub App installation is acknowledged instead of treated as OAuth failure", async () => {
    const app = new Hono();
    mountMcp(app);
    const r = await app.request("/github/oauth/callback?installation_id=123&setup_action=install");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("GitHub App installed");
  });

  test("starts a personal PKCE authorization without accepting an API key", async () => {
    const c = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK" });
    const { authUrl } = await startGithubConnect(c.id);
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("Iv1_test");
    expect(u.searchParams.get("redirect_uri")).toBe("https://brain.example/github/oauth/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")?.startsWith(`${c.id}.`)).toBe(true);
    const auth = await readAuth(c.id);
    expect(auth.accessToken).toBeUndefined();
    expect(auth.state).toBe(u.searchParams.get("state") ?? undefined);
    expect(auth.codeVerifier).toBeTruthy();
  });

  test("a GitHub OAuth connection can never become workspace-wide", async () => {
    await expect(createConnection({ provider: "github", scope: "org" })).rejects.toThrow(/personally/);
    const c = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK" });
    await expect(makeWorkspaceWide(c.id)).rejects.toThrow(/personally/);
  });
});
