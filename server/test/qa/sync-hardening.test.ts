// QA M3: token-bearing sync providers must not be steerable to attacker hosts/paths.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { settings } from "../../src/db/schema";
import { assertJiraBase } from "../../src/sync";
import { github } from "../../src/sync/providers/github";
import { db, resetDb } from "../db";

const realFetch = globalThis.fetch;
beforeEach(resetDb);
afterEach(() => { globalThis.fetch = realFetch; });

test("jira base url: https + atlassian.net or allow-listed only; no IPs / localhost / userinfo", async () => {
  await assertJiraBase("https://acme.atlassian.net");
  for (const bad of ["http://acme.atlassian.net", "https://169.254.169.254", "https://127.0.0.1", "https://localhost", "https://[::1]", "https://evil.example.com", "https://u:p@acme.atlassian.net", "https://acme.atlassian.net.evil.com"])
    await expect(assertJiraBase(bad)).rejects.toThrow();
  await expect(assertJiraBase("https://jira.corp.example")).rejects.toThrow();
  await db.insert(settings).values({ key: "sync_jira_hosts", value: ["jira.corp.example"] });
  await assertJiraBase("https://jira.corp.example");
});

test("github: path-traversing repo ids and doc paths are refused before any request", async () => {
  let hit = false;
  globalThis.fetch = (async () => { hit = true; return Response.json({}); }) as unknown as typeof fetch;
  const auth = { accessToken: "t" };
  await expect(github.listChanges(auth, null, { ids: ["../../user"] })).rejects.toThrow("invalid github repo id");
  await expect(github.listChanges(auth, null, { ids: ["a/b?x=1"] })).rejects.toThrow();
  await expect(github.fetchDoc(auth, { id: "a/b:../../secrets", name: "x", mimeType: "text/plain" })).rejects.toThrow("invalid github doc id");
  await expect(github.fetchDoc(auth, { id: "a/b#12abc", name: "x", mimeType: "text/plain" })).rejects.toThrow("invalid github doc id");
  expect(hit).toBe(false);
});
