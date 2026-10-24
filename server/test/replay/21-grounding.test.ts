import "../slack/env";
// Replay: refuse-or-ask, never guess. A scripted model that hallucinates a link, restates the question ("Our Berlin office is located in
// Berlin."), and claims it notified someone it never touched; the deterministic guards must catch each. LIVE_MODEL=1 runs the same
// abstention questions against the real model.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { answerChecks, commitments } from "../../src/db/schema";
import { putSetting } from "../../src/manager/commitments";
import { ABSTAIN_REPLY } from "../../src/turn/verify-answer";
import { clearGroundingFlags } from "../../src/turn/grounding";
import { seedMemory } from "../memory/helpers";
import { PARAG, PUB, boot, dm, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); clearGroundingFlags(); });
afterAll(() => { clearGroundingFlags(); teardown(); });

const checks = () => db.select().from(answerChecks);
const final = () => slack.texts().at(-1)!;
const PERMALINK = "https://acme.slack.com/archives/CPUB/p1700000000";

describe("hallucinated links", () => {
  scriptedTest("a made-up link and a made-up bare URL are stripped (label kept); the recalled permalink survives", async () => {
    await seedMemory("shared", "Priya Raman owns the Sandpiper billing migration", { permalink: PERMALINK });
    scriptModel(() => ({ text: `Priya Raman owns the Sandpiper billing migration. Sources: <${PERMALINK}|Slack thread, Oct 3> · <https://made-up.example.org/wiki|Billing wiki> and https://fake.example.net/x` }));
    await send(mention("Who owns the Sandpiper billing migration?"));
    expect(final()).toContain(PERMALINK);
    expect(final()).toContain("Billing wiki");
    expect(final()).not.toContain("made-up.example.org");
    expect(final()).not.toContain("fake.example.net");
    expect(await checks()).toMatchObject([{ signal: "strong", strippedLinks: 2, tautologyBlocked: false, abstained: false }]);
  });

  scriptedTest("a link the asker typed this turn is allowed", async () => {
    scriptModel(() => ({ text: "That runbook is <https://docs.example.com/runbook|the runbook> you linked." }));
    await send(mention("what does the oncall rotation in https://docs.example.com/runbook cover?"));
    expect(final()).toContain("docs.example.com/runbook");
    expect((await checks())[0]?.strippedLinks ?? 0).toBe(0);
  });
});

describe("Berlin tautology and unknown entities", () => {
  scriptedTest("signal none injects <grounding>; 'Our Berlin office is located in Berlin.' is replaced by an honest abstention", async () => {
    await seedMemory("shared", "The Lisbon office lease renews every March and the office is on the fourth floor");
    let grounded = false;
    scriptModel((s) => { grounded = s.last.includes("<grounding>") && s.last.includes("Memory has nothing relevant"); return { text: "Our Berlin office is located in Berlin." }; });
    await send(mention("Which city is our Berlin office in?"));
    expect(grounded).toBe(true);
    expect(final()).toContain("I don't have a record that answers that");
    expect(final()).not.toContain("located in Berlin");
    expect(await checks()).toMatchObject([{ signal: "none", abstained: true, tautologyBlocked: true }]);
  });

  scriptedTest("a model that follows the instruction abstains by itself and is left alone", async () => {
    scriptModel(() => ({ text: "I don't have anything on a Berlin office in memory. I could ask Dana, or check a connected tool." }));
    await send(mention("Which city is our Berlin office in?"));
    expect(final()).toContain("I don't have anything on a Berlin office");
    expect(await checks()).toMatchObject([{ signal: "none", abstained: true, tautologyBlocked: false }]);
  });

  scriptedTest("the abstain instruction is for factual questions only: not small talk, not a task action", async () => {
    const seen: string[] = [];
    scriptModel((s) => { seen.push(s.last); return { text: "Anytime." }; });
    await send(dm("thanks!"));
    await send(mention("hey there"));
    await send(mention("tell <@" + PARAG + "> hello and that lunch is at noon"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((l) => l.includes("<grounding>"))).toBe(false);
  });

  scriptedTest("thin evidence (weak): 'Evidence is thin' instead of the hard abstention", async () => {
    await seedMemory("shared", "Sandpiper billing runs on a nightly schedule");
    let block = "";
    scriptModel((s) => { block = /<grounding>[\s\S]*<\/grounding>/.exec(s.last)?.[0] ?? ""; return { text: "Sandpiper billing runs nightly, per one note." }; });
    await send(mention("Who owns the Sandpiper billing and when was it last changed?"));
    expect(block === "" || block.includes("Evidence is thin")).toBe(true);
  });
});

describe("escalate on abstain", () => {
  scriptedTest("memory abstains on a question that may live in a connected tool: exactly one retry at tools depth", async () => {
    const model = scriptModel((s) => s.toolNames.includes("people_search")
      ? { text: "Zephyr's public price is 9 dollars a month, per their pricing page." }
      : { text: "I don't have that in memory." });
    await send(mention("What is the public price of Zephyr hosting?"));
    expect(model.doStreamCalls).toHaveLength(2);
    expect(final()).toContain("9 dollars");
    expect(slack.texts().some((t) => t.includes("I don't have that in memory"))).toBe(false); // the abstaining draft was never shown
    expect(await checks()).toMatchObject([{ signal: "none", escalated: true }]);
  });

  scriptedTest("one hop only: if tools depth also comes up empty, that answer is final", async () => {
    const model = scriptModel(() => ({ text: "I couldn't find anything on that in memory or my tools." }));
    await send(mention("What is the public price of Zephyr hosting?"));
    expect(model.doStreamCalls).toHaveLength(2);
    expect(final()).toContain("couldn't find anything");
  });

  scriptedTest("no connected-tool hint: no escalation", async () => {
    const model = scriptModel(() => ({ text: "I don't have that in memory." }));
    await send(mention("Who owns the Orchid vendor contract?"));
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await checks())[0]!.escalated).toBe(false);
  });
});

describe("write claims need a matching receipt", () => {
  scriptedTest("'Done, Dana has been notified' with no tool: one repair, then an honest line (never the claim)", async () => {
    const model = scriptModel(() => ({ text: "Done, Eve has been notified." }));
    await send(mention("tell Eve the deploy is done"));
    expect(model.doStreamCalls).toHaveLength(2);
    expect(final()).toContain("didn't actually do that");
    expect(final()).not.toContain("has been notified");
    expect((await checks())[0]!.receiptMismatch).toBe(true);
  });

  scriptedTest("notified Parag but claims Eve: the claim is for someone else, so it is blocked", async () => {
    scriptModel((s) => (s.called("notify_teammate") ? { text: "Done, Eve has been notified." } : { call: "notify_teammate", input: { person: `<@${PARAG}>`, message: "the deploy is done" } }));
    await send(mention(`tell <@${PARAG}> the deploy is done`));
    expect(final()).toContain("didn't actually do that");
    expect((await checks())[0]!.receiptMismatch).toBe(true);
  });

  scriptedTest("a real assign_task: the reply gets a receipt (id, assignee, due) the model's prose lacked", async () => {
    scriptModel((s) => (s.called("assign_task") ? { text: "Done, it's with Parag." } : { call: "assign_task", input: { title: "Tales launch", assignee: `<@${PARAG}>`, due: "2030-06-12" } }));
    await send(mention(`assign the Tales launch to <@${PARAG}> by June 12`));
    const [c] = await db.select().from(commitments);
    expect(final()).toContain("— receipt:");
    expect(final()).toContain(c!.id);
    expect(final()).toContain("due 2030-06-12");
    expect((await checks())[0]).toMatchObject({ receiptMismatch: false });
  });

  scriptedTest("a reply that already names the notified person gets no receipt line", async () => {
    scriptModel((s) => (s.called("notify_teammate") ? { text: "Done, I've told Parag." } : { call: "notify_teammate", input: { person: `<@${PARAG}>`, message: "the deploy is done" } }));
    await send(mention(`tell <@${PARAG}> the deploy is done`));
    expect(final()).toContain("told Parag");
    expect(final()).not.toContain("— receipt:");
  });
});

describe("flags off restore today's behaviour", () => {
  scriptedTest("grounding_signal / grounding_citations / grounding_receipts = false: tautology and made-up links pass through, no <grounding>, no receipt, no rows", async () => {
    await putSetting("grounding_signal", false);
    await putSetting("grounding_citations", false);
    await putSetting("grounding_receipts", false);
    clearGroundingFlags();
    await seedMemory("shared", "The Lisbon office lease renews every March");
    let grounded = true;
    scriptModel((s) => { grounded = s.last.includes("<grounding>"); return { text: "Our Berlin office is located in Berlin. See <https://made-up.example.org/wiki|wiki>." }; });
    await send(mention("Which city is our Berlin office in?"));
    expect(grounded).toBe(false);
    expect(final()).toContain("located in Berlin");
    expect(final()).toContain("made-up.example.org");
    expect(await checks()).toHaveLength(0);

    scriptModel((s) => (s.called("assign_task") ? { text: "Done, it's with Parag." } : { call: "assign_task", input: { title: "Tales launch", assignee: `<@${PARAG}>` } }));
    await send(mention(`assign the Tales launch to <@${PARAG}>`));
    expect(final()).not.toContain("— receipt:");
  });
});

// ---- the real model ----------------------------------------------------------------------------------------------
const ABSTAINS = /don'?t have|no record|not (in|something|sure)|couldn'?t find|can'?t find|nothing|no information|unable|haven'?t|i'?m not aware|don'?t know|not aware/i;
describe("real model: refuse or ask, never guess", () => {
  const QUESTIONS = [
    "Which city is our Berlin office in?",
    "What is the name of the CEO's pet iguana?",
    "What is the wifi password at the Osaka hotel?",
    "Which volcano erupted near the Reykjavik datacenter?",
    "Who won the 1998 chess tournament in Tbilisi?",
    "What colour is the CTO's sailboat?",
  ];
  for (const q of QUESTIONS) {
    liveTest(`abstains: ${q}`, async () => {
      await seedMemory("shared", "The Lisbon office lease renews every March and the office is on the fourth floor");
      await send(mention(q));
      const reply = final();
      console.log(`LIVE ${q} => ${reply.replace(/\s+/g, " ").slice(0, 300)}`);
      expect(reply).not.toMatch(/Berlin office is (located )?in Berlin/i);
      expect(reply === ABSTAIN_REPLY || ABSTAINS.test(reply)).toBe(true);
    }, 180_000);
  }
});
