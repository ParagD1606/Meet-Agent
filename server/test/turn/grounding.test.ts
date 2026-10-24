import "./env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { putSetting } from "../../src/manager/commitments";
import type { Signal } from "../../src/memory/signal";
import { isFactualQuestion } from "../../src/turn/depth";
import { appNamesOf, clearGroundingFlags, groundingBlock, groundingFlag, shouldEscalate } from "../../src/turn/grounding";
import { buildDynamicContext } from "../../src/turn/prompt";
import { unbackedTargets } from "../../src/turn/loop";
import {
  ABSTAIN_REPLY, allowlist, appendReceipts, claimTargets, isTautology, receiptsOf, stripUnsourcedLinks, targetBacked, verifyAnswer, withReceipt,
} from "../../src/turn/verify-answer";

const sig = (level: Signal["level"]): Signal => ({ level, reason: "test", features: { topRank: 0, gap: 0, aboveMin: 0, count: 0, lexical: false, shared: 0, maxCos: 0, named: 0, covered: 0 } });

describe("isFactualQuestion", () => {
  test("company-knowledge questions", () => {
    for (const q of ["Which city is our Berlin office in?", "who owns billing?", "What's our refund policy", "Do we have a security questionnaire?", "tell me about the Kepler contract", "the Q3 revenue target?"]) expect(isFactualQuestion(q), q).toBe(true);
  });
  test("not greetings, small talk, requests, task actions, saves, corrections or link messages", () => {
    for (const q of ["thanks!", "hey", "can you check the deploy?", "please summarise this", "assign the Tales launch to Parag", "tell Parag the deploy is done", "remind me to call Dana tomorrow",
      "remember that billing is owned by Dana", "actually that's wrong, it's Priya", "what does https://example.com/x say?", "continue", ""]) expect(isFactualQuestion(q), q).toBe(false);
  });
});

describe("<grounding> block", () => {
  const q = "Which city is our Berlin office in?";
  test("none on a factual question: the hard abstain instruction (and it lives in the dynamic context, not STATIC_SYSTEM)", () => {
    const b = groundingBlock(sig("none"), { depth: "memory", text: q });
    expect(b).toContain("Memory has nothing relevant");
    expect(b).toContain("ask_teammate");
    expect(b).toContain("Do not guess");
    expect(buildDynamicContext({ now: new Date(), botUserId: "U", asker: null, trigger: "mention", isIm: true, isPrivate: false, readOnly: false, depth: "memory", connectionNotes: [], grounding: b })).toContain("<grounding>");
  });
  test("weak: label uncertainty, do not extrapolate", () => {
    expect(groundingBlock(sig("weak"), { depth: "memory", text: q })).toContain("Evidence is thin");
  });
  test("tools depth: live tools may still have it", () => {
    expect(groundingBlock(sig("none"), { depth: "tools", text: q })).toContain("Live tools may still have it");
  });
  test("strong, missing signal, greetings, task actions and direct depth get nothing", () => {
    expect(groundingBlock(sig("strong"), { depth: "memory", text: q })).toBe("");
    expect(groundingBlock(undefined, { depth: "memory", text: q })).toBe("");
    expect(groundingBlock(sig("none"), { depth: "memory", text: "thanks!" })).toBe("");
    expect(groundingBlock(sig("none"), { depth: "tools", text: "assign the Tales launch to Parag" })).toBe("");
    expect(groundingBlock(sig("none"), { depth: "direct", text: q })).toBe("");
  });
});

describe("escalate-on-abstain", () => {
  const base = { depth: "memory" as const, signal: sig("none"), text: "What is the public price of Zephyr hosting?", interactive: true, appNames: [] as string[], usedTools: false, replied: "I don't have that in memory." };
  test("memory depth + none + factual + a connected-tool hint + the reply abstains -> escalate", () => {
    expect(shouldEscalate(base)).toBe(true);
    expect(shouldEscalate({ ...base, text: "What is our Stripe churn?", appNames: ["Stripe"] })).toBe(true);
  });
  test("never when memory had it, at tools depth, for chimes, after live tool use, without a tool hint, or when the reply answered", () => {
    expect(shouldEscalate({ ...base, signal: sig("weak") })).toBe(false);
    expect(shouldEscalate({ ...base, depth: "tools" })).toBe(false);
    expect(shouldEscalate({ ...base, interactive: false })).toBe(false);
    expect(shouldEscalate({ ...base, usedTools: true })).toBe(false);
    expect(shouldEscalate({ ...base, text: "Who owns billing?" })).toBe(false);
    expect(shouldEscalate({ ...base, replied: "It costs 9 dollars a month." })).toBe(false);
  });
  test("connection notes -> app names", () => {
    expect(appNamesOf(["you can use GitHub (personal, read+write), Linear (workspace, read-only)", "other note"])).toEqual(["GitHub", "Linear"]);
  });
});

describe("tautology guard", () => {
  const q = "Which city is our Berlin office in?";
  test("the Berlin case: 'Our Berlin office is located in Berlin.' with nothing backing it", () => {
    expect(isTautology(q, "Our Berlin office is located in Berlin.", ["The Lisbon office lease renews every March"])).toBe(true);
    const v = verifyAnswer({ text: "Our Berlin office is located in Berlin.", question: q, factual: true, support: ["The Lisbon office lease renews every March"], urlSources: [], acted: false, tautology: true, citations: true });
    expect(v).toMatchObject({ text: ABSTAIN_REPLY, tautologyBlocked: true });
  });
  test("a real answer, an honest abstention, or a restatement that a recalled hit supports is kept", () => {
    expect(isTautology(q, "Berlin is in Germany, per the Q2 offsite notes.", [])).toBe(false);
    expect(isTautology(q, "I don't have that: nothing on the Berlin office is in memory.", [])).toBe(false);
    expect(isTautology(q, "Our Berlin office is located in Berlin.", ["The Berlin office is in Berlin, Kreuzberg district"])).toBe(false);
    expect(isTautology("Who owns billing?", "Priya owns billing.", [])).toBe(false);
  });
  test("not applied to non-factual turns or turns that acted", () => {
    expect(verifyAnswer({ text: "Our Berlin office is located in Berlin.", question: q, factual: false, support: [], urlSources: [], acted: false, tautology: true, citations: false }).tautologyBlocked).toBe(false);
    expect(verifyAnswer({ text: "Our Berlin office is located in Berlin.", question: q, factual: true, support: [], urlSources: [], acted: true, tautology: true, citations: false }).tautologyBlocked).toBe(false);
    expect(verifyAnswer({ text: "Our Berlin office is located in Berlin.", question: q, factual: true, support: [], urlSources: [], acted: false, tautology: false, citations: false }).tautologyBlocked).toBe(false);
  });
});

describe("citation allowlist", () => {
  const permalink = "https://acme.slack.com/archives/C1/p1700000000";
  const toolUrl = "https://github.com/acme/api/pull/42";
  const asker = "https://docs.example.com/runbook";
  const allow = allowlist([`- fact (slack, 2026-03-01) <${permalink}|Slack thread, Mar 1>`, `{"url":"${toolUrl}"}`, `<@U1>: see <${asker}|the runbook> please`]);
  const bad = "https://made-up.example.org/page";

  test("hallucinated links are stripped, label text kept; allowlisted ones (recalled, tool-returned, asker-typed) never", () => {
    const r = stripUnsourcedLinks(`Priya owns it. Sources: <${permalink}|Slack thread, Mar 1> · <${bad}|Wiki page> · ${toolUrl} · [runbook](${asker})`, allow);
    expect(r.stripped).toBe(1);
    expect(r.text).toContain(`<${permalink}|Slack thread, Mar 1>`);
    expect(r.text).toContain(toolUrl);
    expect(r.text).toContain(`[runbook](${asker})`);
    expect(r.text).toContain("Wiki page");
    expect(r.text).not.toContain("made-up.example.org");
  });
  test("bare URL, <url>, <url|label> and markdown links", () => {
    expect(stripUnsourcedLinks(`See ${bad}.`, allow)).toEqual({ text: "See.", stripped: 1 });
    expect(stripUnsourcedLinks(`See <${bad}> now`, allow)).toMatchObject({ text: "See now", stripped: 1 });
    expect(stripUnsourcedLinks(`See <${bad}|the doc> now`, allow)).toEqual({ text: "See the doc now", stripped: 1 });
    expect(stripUnsourcedLinks(`See [the doc](${bad}) now`, allow)).toEqual({ text: "See the doc now", stripped: 1 });
  });
  test("trailing punctuation, fragments and case in the host do not defeat the allowlist", () => {
    expect(stripUnsourcedLinks(`PR: ${toolUrl}.`, allow).stripped).toBe(0);
    expect(stripUnsourcedLinks(`PR: https://GitHub.com/acme/api/pull/42#issuecomment-9`, allow).stripped).toBe(0);
    expect(stripUnsourcedLinks(`A lookalike: https://github.com/acme/api/pull/43`, allow).stripped).toBe(1);
  });
  test("a Sources line left empty is removed; mentions and channels are untouched; no links = unchanged", () => {
    expect(stripUnsourcedLinks(`Priya owns it.\nSources: <${bad}>`, allow).text).toBe("Priya owns it.");
    expect(stripUnsourcedLinks("Ping <@U123> in <#C1|general>", allow)).toEqual({ text: "Ping <@U123> in <#C1|general>", stripped: 0 });
  });
  test("fast: a long reply with many links is well under 5 ms", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} <https://x.example/${i}|l${i}> and https://y.example/${i}`).join("\n");
    const t0 = performance.now();
    stripUnsourcedLinks(text, allow);
    expect(performance.now() - t0).toBeLessThan(5);
  });
});

describe("write receipts and claim targets", () => {
  const assign = withReceipt("Created task t_ab12 for <@UPARAG>.", "t_ab12", 'Created task t_ab12 "Tales launch" for Parag (UPARAG), due 2026-06-12, assignee sent a DM');
  const notify = withReceipt("Sent <@UPARAG> a DM.", "Parag/UPARAG", "Message to Parag (UPARAG) sent by DM");

  test("receipts come from tool results; errors and consent-held writes produce none", () => {
    expect(receiptsOf([{ name: "assign_task", text: assign }, { name: "notify_teammate", text: notify }, { name: "assign_task", text: "ERROR: nope" }, { name: "notify_teammate", text: "Posted a consent card" }]).map((r) => r.keys[0])).toEqual(["t_ab12", "Parag"]);
  });
  test("appended only when the reply lacks the facts (id / person)", () => {
    const outs = [{ name: "assign_task", text: assign }];
    expect(appendReceipts("Done, assigned to Parag.", outs).text).toContain("— receipt: Created task t_ab12");
    expect(appendReceipts("Done: task t_ab12 is Parag's.", outs).added).toBe(0);
    expect(appendReceipts("Sent.", [{ name: "notify_teammate", text: notify }]).text).toContain("— receipt: Message to Parag");
    expect(appendReceipts("I told Parag.", [{ name: "notify_teammate", text: notify }]).added).toBe(0);
    expect(appendReceipts("Done.", []).added).toBe(0);
  });
  test("MCP write results (url or id) get a generic receipt", () => {
    const [r] = receiptsOf([{ name: "github_create_issue", text: '{"id":"I_99","html_url":"https://github.com/acme/api/issues/7"}' }]);
    expect(r!.display).toContain("github create issue done");
    expect(r!.keys[0]).toBe("https://github.com/acme/api/issues/7");
    expect(receiptsOf([{ name: "github_list_issues", text: "[]" }])).toEqual([]); // reads never
  });
  test("claim targets: who the reply says it told / notified", () => {
    expect(claimTargets("Done, Dana has been notified.")).toEqual(["Dana"]);
    expect(claimTargets("I've told Parag Singh about it and notified <@UEVE>.")).toEqual(["Parag Singh", "<@UEVE>"]);
    expect(claimTargets("I assigned this to Priya.")).toEqual(["Priya"]);
    expect(claimTargets("Done, I've sent it.")).toEqual([]);
  });
  test("a claim for Dana needs a successful write result that mentions Dana", () => {
    const acts = [{ name: "notify_teammate", text: notify }];
    expect(targetBacked("Parag", acts)).toBe(true);
    expect(targetBacked("<@UPARAG>", acts)).toBe(true);
    expect(targetBacked("Dana", acts)).toBe(false);
    expect(targetBacked("Parag", [{ name: "notify_teammate", text: "ERROR: could not deliver Parag" }])).toBe(false);
  });
  test("unbackedTargets: 'Done, Dana has been notified' with no notify/assign result for Dana", () => {
    expect(unbackedTargets({ text: "Done, Dana has been notified.", waitingApproval: false, toolOutputs: [] })).toEqual(["Dana"]);
    expect(unbackedTargets({ text: "Done, Dana has been notified.", waitingApproval: false, toolOutputs: [{ name: "notify_teammate", text: notify }] })).toEqual(["Dana"]);
    expect(unbackedTargets({ text: "Done, I've told Parag.", waitingApproval: false, toolOutputs: [{ name: "notify_teammate", text: notify }] })).toEqual([]);
    expect(unbackedTargets({ text: "Done, Dana has been notified.", waitingApproval: true, toolOutputs: [] })).toEqual([]);
    expect(unbackedTargets({ text: "Priya was assigned to billing in March.", waitingApproval: false, toolOutputs: [] })).toEqual([]); // a remembered fact, not a claim of acting
  });
});

describe("grounding flags", () => {
  beforeEach(async () => { await resetDb(); clearGroundingFlags(); });
  afterAll(clearGroundingFlags);
  test("default on; switched off by a setting within the cache window; each flag is independent", async () => {
    expect(await groundingFlag("grounding_signal")).toBe(true);
    await putSetting("grounding_signal", false);
    await putSetting("grounding_citations", "off");
    clearGroundingFlags();
    expect(await groundingFlag("grounding_signal")).toBe(false);
    expect(await groundingFlag("grounding_citations")).toBe(false);
    expect(await groundingFlag("grounding_receipts")).toBe(true);
    await putSetting("grounding_signal", true);
    clearGroundingFlags();
    expect(await groundingFlag("grounding_signal")).toBe(true);
  });
});
