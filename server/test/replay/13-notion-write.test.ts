import "../slack/env";
// Replay: "@Pixel can you make a new notion note with demo title please" with a Workspace (org) Notion connection and a MEMBER asker.
// Bugs: the write either never happened, happened twice, or (workspace writes off) Pixel said the tools were "not exposed" instead of
// saying that writes are disabled for workspace connections and how an admin enables them.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { approvals } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { setApprovalCards } from "../../src/mcp/policy";
import { setOrgWrites } from "../../src/mcp/writes";
import { handleBlockAction, settled } from "../../src/turn/approval";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, boot, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Seen, type Slack, type Step } from "./harness";
import { creates, mcp, said, useFakeMcp } from "./mcp";

let slack: Slack;
beforeEach(async () => {
  slack = await boot();
  await createConnection({ provider: "notion", scope: "org", token: "good" });
});
useFakeMcp();
afterAll(teardown);

const ASK = "can you make a new notion note with demo title please";
const create = (title: string) => ({ call: "call_tool", input: { name: "notion__notion-create-pages", args: JSON.stringify({ pages: [{ title }] }) } });
/** search -> create -> reply from what the tool returned (like a competent model would). */
const flow = (s: Seen): Step => {
  if (s.n === 1) return { call: "search_tools", input: { query: "create a new page note" } };
  if (s.n === 2) return create("demo title");
  if (s.prompt.includes("awaiting_approval")) return { text: "I posted an approval card; I'll create the note once you approve it." };
  if (s.prompt.includes("Writes are disabled for workspace connections")) return { text: "Writes are disabled for workspace connections, so I can't create it. An admin can enable writes in Integrations settings." };
  return { text: "Created the note: https://notion.so/new" };
};
const cards = async () => db.select().from(approvals);

describe("a member asks Pixel to create a Notion page through the workspace connection", () => {
  scriptedTest("org writes ON (default): exactly one create-pages call reaches the server, the reply links the page, no card", async () => {
    scriptModel(flow);
    await send(mention(ASK));
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.args).toEqual({ pages: [{ title: "demo title" }] });
    expect(creates()[0]!.auth).toBe("Bearer good");
    expect(await cards()).toHaveLength(0);
    expect(slack.texts().at(-1)).toContain("https://notion.so/new");
  });

  scriptedTest("org writes ON but the admin carded doc edits: one approval card, nothing runs; Approve runs it exactly once", async () => {
    await setApprovalCards({ doc_edit: true });
    scriptModel(flow);
    await send(mention(ASK));
    expect(creates()).toHaveLength(0);
    const rows = await cards();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requesterId: ME, status: "pending" });
    expect(slack.posts().some((p) => JSON.stringify(p.blocks ?? []).includes("approval_approve"))).toBe(true);
    await handleBlockAction({ user: { id: ME }, actions: [{ action_id: "approval_approve", value: rows[0]!.id }] });
    await settled();
    expect(creates()).toHaveLength(1);
    expect(mcp.followUps[0]!.text).toContain("https://notion.so/new");
  });

  scriptedTest("org writes OFF: nothing runs, the model is told writes are disabled for workspace connections and who can enable them", async () => {
    await setOrgWrites(false);
    const model = scriptModel(flow);
    await send(mention(ASK));
    expect(creates()).toHaveLength(0);
    expect(await cards()).toHaveLength(0);
    const seen = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(seen).toContain("read-only: an admin has not allowed writes"); // the apps note in the system context
    expect(seen).toContain("writes are disabled for workspace connections");
    expect(seen).toContain("Writes are disabled for workspace connections"); // the answer to the blocked call_tool
    expect(seen).toContain("Integrations settings");
    expect(seen).not.toContain("unknown tool"); // it must not look like a missing tool
    const reply = slack.texts().at(-1)!;
    expect(reply).toMatch(/disabled for workspace connections/);
    expect(reply).toMatch(/admin/);
    expect(reply).not.toMatch(/not exposed/i);
  });

  scriptedTest("a notion write on a turn that already read external content is carded, never run immediately", async () => {
    const model = scriptModel((s) => {
      if (s.n === 1) return { call: "search_tools", input: { query: "search roadmap and create page" } };
      if (s.n === 2) return { call: "call_tool", input: { name: "notion__notion-search", args: JSON.stringify({ query: "roadmap" }) } };
      if (s.n === 3) return create("from roadmap");
      return { text: "I posted an approval card for the new page." };
    });
    await send(mention("read our roadmap in notion and make a new notion note with demo title"));
    expect(creates()).toHaveLength(0);
    expect(mcp.fake.calls.map((c) => c.tool)).toEqual(["notion-search"]);
    expect(await cards()).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain("awaiting_approval");
  });

  liveTest("live model, org writes ON: one create call (or one card), never two, link in the reply when it ran", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(mention(ASK));
    const rows = await cards();
    expect(creates().length).toBeLessThanOrEqual(1);
    expect(creates().length + rows.length).toBe(1); // it ran, or exactly one card asks for it
    if (creates().length) expect(said(slack.posts())).toContain("notion.so/new");
    else expect(slack.posts().some((p) => JSON.stringify(p.blocks ?? []).includes("approval_approve"))).toBe(true);
    expect(slack.texts().at(-1)).not.toMatch(/not exposed/i);
  }, 180_000);

  liveTest("live model, org writes OFF: nothing runs; the reply says writes are disabled for workspace connections / admin, never 'not exposed'", async () => {
    setLoopModel(); setModelResolverForTest();
    await setOrgWrites(false);
    await send(mention(ASK));
    expect(creates()).toHaveLength(0);
    expect(await cards()).toHaveLength(0);
    const reply = slack.texts().at(-1)!;
    expect(reply).toMatch(/disabled|not (allowed|enabled|permitted)|admin|read-only/i);
    expect(reply).not.toMatch(/not exposed|don'?t have (access to )?notion|no notion/i);
  }, 180_000);
});
