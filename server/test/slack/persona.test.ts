import { describe, expect, test } from "bun:test";
import { onAppHome, onUserJoined } from "../../src/slack/onboarding";
import { onAssistantThreadStarted } from "../../src/slack/assistant";
import { setPersona, DEFAULT_PERSONA } from "../../src/persona";
import { setup } from "./helpers";

describe("persona in Slack surfaces", () => {
  test("defaults to Pixel in welcome, home and assistant pane", async () => {
    const { fake } = await setup();
    await onUserJoined("U9");
    expect(JSON.stringify(fake.calls.find((c) => c.method === "chat.postMessage")!.args)).toContain("I'm Pixel");
    await onAppHome("U9");
    expect(JSON.stringify(fake.calls.find((c) => c.method === "views.publish")!.args.view)).toContain("Pixel");
    await onAssistantThreadStarted({ assistant_thread: { channel_id: "D1", thread_ts: "1.1" } });
    expect(fake.calls.find((c) => c.method === "assistant.threads.setSuggestedPrompts")!.args.title).toBe("Hi, I'm Pixel. What can I help with?");
  });

  test("override name is used", async () => {
    const { fake } = await setup();
    expect((await setPersona({ ...DEFAULT_PERSONA, name: "Juniper" })).ok).toBe(true);
    await onUserJoined("U8");
    expect(JSON.stringify(fake.calls.find((c) => c.method === "chat.postMessage")!.args)).toContain("I'm Juniper");
    await onAppHome("U8");
    expect(JSON.stringify(fake.calls.find((c) => c.method === "views.publish")!.args.view)).toContain("Juniper");
  });
});
