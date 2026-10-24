// Replay: a long DM goes stale; the user says "new chat" and expects a clean slate without losing what Pixel knows.
import "../slack/env";
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { commitments, memories, settings, threadState } from "../../src/db/schema";
import { addFact } from "../../src/memory/facts";
import { runSlashCommand } from "../../src/slack/commands";
import { ME, boot, dm, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const FRESH = /Fresh start\. I still remember our company knowledge, tasks and your notes/;

describe("new chat", () => {
  scriptedTest("DM 'new chat': zero pre-reset tokens in the next prompt; memories, tasks and open asks stay", async () => {
    const prompts: string[] = [];
    scriptModel((s) => { prompts.push(s.prompt); return { text: "Noted QUOKKA-REPLY." }; });
    await addFact({ tag: `user_${ME}`, text: "Dana prefers Friday demos", source: "slack", sourceRef: "t", createdBy: ME, factType: "fact", confidence: 0.9, agentContext: "primary" });
    await db.insert(commitments).values({ id: "c1", text: "ship the beta", sourceType: "message", sourceRef: "m:1", ownerId: ME, assignerId: ME, scopeTag: `user_${ME}`, status: "open" });
    await db.insert(settings).values({ key: "ask:a1", value: { id: "a1", status: "sent", owner: ME } });

    await send(dm("hello ZEBRA-TOKEN planning notes"));
    await send(dm("and also ZEBRA-TOKEN again"));
    expect(prompts.at(-1)).toContain("ZEBRA-TOKEN planning notes"); // control: history is visible before the reset
    expect(prompts.at(-1)).toContain("QUOKKA-REPLY");

    const calls = prompts.length;
    slack.reset();
    await send(dm("New Chat"));
    expect(prompts.length).toBe(calls); // the reset is not a model turn
    expect(slack.to("D_DANA").some((p) => FRESH.test(p.text))).toBe(true);
    expect((await db.select().from(threadState).where(eq(threadState.threadTs, "dm")))[0]!.contextResetAt).not.toBeNull();

    await send(dm("what were we on?"));
    const next = prompts.at(-1)!;
    expect(next).toContain("what were we on?");
    expect(next).not.toContain("ZEBRA-TOKEN");
    expect(next).not.toContain("QUOKKA-REPLY");

    expect((await db.select().from(memories)).some((m) => /Friday demos/.test(m.text) && m.status === "active")).toBe(true);
    expect((await db.select().from(commitments))[0]!.status).toBe("open");
    expect((await db.select().from(settings).where(eq(settings.key, "ask:a1")))[0]!.value).toMatchObject({ status: "sent" });
  });

  scriptedTest("a request that merely contains 'reset' is a normal turn", async () => {
    const prompts: string[] = [];
    scriptModel((s) => { prompts.push(s.prompt); return { text: "ok" }; });
    await send(dm("can you reset my password"));
    expect(prompts).toHaveLength(1);
    expect(slack.texts().some((t) => FRESH.test(t))).toBe(false);
  });

  scriptedTest("/brain-new in a DM resets the same way; in a channel it explains where to use it", async () => {
    const prompts: string[] = [];
    scriptModel((s) => { prompts.push(s.prompt); return { text: "ok QUOKKA-REPLY" }; });
    await send(dm("remember ZEBRA-TOKEN"));
    const r = await runSlashCommand({ command: "/brain-new", user_id: ME, channel_id: "D_DANA" });
    expect(r!.text).toMatch(FRESH);
    expect((await db.select().from(threadState).where(eq(threadState.threadTs, "dm")))).toHaveLength(1);
    const c = await runSlashCommand({ command: "/brain-new", user_id: ME, channel_id: "CPUB" });
    expect(c!.text).toMatch(/DM/);
    await send(dm("fresh question"));
    expect(prompts.at(-1)).not.toContain("ZEBRA-TOKEN");
  });
});
