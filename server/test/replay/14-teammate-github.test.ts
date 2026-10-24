import "../slack/env";
// Replay: "@Pixel ok can you tell the repos you can access" when GitHub exists only as ANOTHER user's personal connection.
// Bug: Pixel answered "I only have access to Notion" / "I don't have GitHub". Right answer: GitHub is connected personally by Parag;
// offer (or do) request_teammate_access, and say an admin can make it workspace-wide. Variant: the asker's own personal GitHub just works.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { leases } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, PARAG, boot, liveTest, mention, offered, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";
import { DENIAL, mcp, said, useFakeMcp } from "./mcp";

let slack: Slack;
beforeEach(async () => {
  slack = await boot();
  await createConnection({ provider: "notion", scope: "org", token: "good" });
});
useFakeMcp();
afterAll(teardown);

const ASK = "ok can you tell the repos you can access";
const lease = async () => db.select().from(leases);
const leaseCard = () => slack.to("D_" + PARAG).filter((p) => JSON.stringify(p.blocks ?? []).includes("lease_allow"));

describe("GitHub exists only as a teammate's personal connection", () => {
  scriptedTest("the model is told who has it; it requests access from the owner and says an admin can make it workspace-wide", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: PARAG, token: "gh-good" });
    const model = scriptModel((s) => s.n === 1
      ? { call: "request_teammate_access", input: { provider: "github", reason: "Dana asked which repos Pixel can access" } }
      : { text: "GitHub is connected personally by Parag, so I can't use it for you directly. I asked Parag for one-time access; an admin can also make it workspace-wide." });
    await send(mention(ASK));
    const first = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(first).toContain("GitHub (by Parag)"); // the apps note
    expect(first).toContain("workspace-wide");
    expect(first).toContain("never say you lack the app");
    expect(offered(model).has("request_teammate_access")).toBe(true);
    // effect: one pending lease from Dana, and Parag got an Allow/Deny card in his DM
    expect(await lease()).toMatchObject([{ requesterId: ME, ownerUserId: PARAG, status: "pending" }]);
    expect(leaseCard()).toHaveLength(1);
    expect(mcp.fake.calls).toHaveLength(0); // nothing ran through Parag's account before he allowed it
    const reply = slack.texts().at(-1)!;
    expect(reply).toContain("Parag");
    expect(reply).toMatch(/admin/);
    expect(reply).not.toMatch(DENIAL);
  });

  scriptedTest("when the asker's own personal GitHub works, it is used and no teammate is bothered", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: ME, token: "gh-good" });
    await createConnection({ provider: "github", scope: "user", ownerUserId: PARAG, token: "gh-good" }); // a teammate's too: still no lease needed
    const model = scriptModel((s) => {
      if (s.n === 1) return { call: "github__list-repositories", input: {} };
      return { text: "Through your GitHub I can access acme/web, acme/api and acme/infra." };
    });
    await send(mention(ASK));
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("GitHub (personal, read+write)");
    expect(offered(model).has("request_teammate_access")).toBe(false);
    expect(mcp.fake.calls.map((c) => c.tool)).toEqual(["list-repositories"]);
    expect(mcp.fake.calls[0]!.auth).toBe("Bearer gh-good");
    expect(slack.texts().at(-1)).toContain("acme/web");
    expect(await lease()).toHaveLength(0);
    expect(leaseCard()).toHaveLength(0);
    expect(slack.texts().at(-1)).not.toMatch(DENIAL);
  });

  liveTest("live model: names Parag, requests access (or offers to), never says it lacks GitHub / only has Notion", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: PARAG, token: "gh-good" });
    setLoopModel(); setModelResolverForTest();
    await send(mention(ASK));
    const reply = said(slack.posts().filter((p) => p.channel === "CPUB"));
    expect(reply).toMatch(/parag/i);
    expect(reply).not.toMatch(DENIAL);
    expect((await lease()).length > 0 || /request|ask|allow/i.test(reply)).toBe(true);
    expect(reply).toMatch(/admin|workspace-wide|workspace wide|workspace-level/i);
  }, 180_000);

  liveTest("live model, asker has their own GitHub: no denial, no teammate request, the app is actually called", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: ME, token: "gh-good" });
    setLoopModel(); setModelResolverForTest();
    await send(mention(ASK));
    expect(slack.texts().at(-1)).not.toMatch(DENIAL);
    expect(await lease()).toHaveLength(0);
    expect(mcp.fake.calls.map((c) => c.tool)).toContain("list-repositories");
    expect(said(slack.posts())).toMatch(/acme\/(web|api|infra)/);
  }, 180_000);
});
