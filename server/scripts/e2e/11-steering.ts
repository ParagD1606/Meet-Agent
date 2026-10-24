// (11) mid-turn steering (APPEND / REPLACE / STOP) with a really running turn, and idempotent posting under replayed events.
import { addFact } from "../../src/memory/supersede";
import { C, U, check, finish, handleEventCallback, mention, nextTs, q, setup, sleep, slack } from "./harness";

await setup();
for (const t of [
  "The Titan launch is scheduled for 2026-11-16 after the SOC2 audit.", "Priya Sharma owns the Titan launch checklist.", "Dana Whitfield owns Titan load testing.",
  "The staging freeze for Titan runs until 2026-11-10.", "Zephyr Corp is the Titan design partner and Jo Lindqvist is their contact.",
  "Titan pricing is $49 per seat per month for the Team plan.", "Risk: the Titan SOC2 audit could slip by two weeks.",
]) await addFact({ tag: "shared", text: t, source: "slack", createdBy: U.ALICE });
const DEEP = "Research everything we know about Titan: give me a comprehensive summary of decisions, owners, dates and risks.";
const turnsOf = (ch: string) => q("select id, status, depth from turns where channel_id=$1 order by started_at", [ch]);
const finals = (ch: string, root: string) => (slack.history.get(ch) ?? []).filter((x) => x.user === "UBOT" && x.thread_ts === root && !/^_(Thinking|Working)/.test(x.text));

// ---- APPEND: extra detail while running -> one notice, one merged follow-up ----
slack.calls.length = 0;
const t0 = Date.now();
const p1 = mention({ channel: C.ENG, user: U.ALICE, text: DEEP });
await sleep(2500);
const rootA = [...(slack.history.get(C.ENG) ?? [])].find((x) => x.user === U.ALICE)!.ts;
await mention({ channel: C.ENG, user: U.ALICE, thread_ts: rootA, text: "Also include who the design partner is, once you're done." });
await mention({ channel: C.ENG, user: U.ALICE, thread_ts: rootA, text: "And the pricing too." });
await p1;
const notices = slack.of("chat.postMessage").filter((c) => /pick it up as soon as I finish/.test(c.args.text ?? ""));
console.log(`APPEND turn took ${Date.now() - t0}ms; replies:`, finals(C.ENG, rootA).map((m) => m.text.slice(0, 100)));
check("exactly one 'I'll pick it up' notice for several queued messages", notices.length === 1, `notices=${notices.length}`);
const rowsA = await turnsOf(C.ENG);
check("queued messages ran as ONE merged follow-up turn (2 turns total, not 3)", rowsA.length === 2, JSON.stringify(rowsA));
const lastA = finals(C.ENG, rootA).at(-1)?.text ?? "";
check("merged follow-up answers both extras (Zephyr + $49)", /Zephyr|Jo Lindqvist/.test(lastA) && /\$49|49/.test(lastA), lastA);

// ---- STOP by the starter ----
slack.calls.length = 0;
const p2 = mention({ channel: C.SALES, user: U.BOB, text: DEEP });
await sleep(2500);
const rootB = [...(slack.history.get(C.SALES) ?? [])].find((x) => x.user === U.BOB)!.ts;
await mention({ channel: C.SALES, user: U.BOB, thread_ts: rootB, text: "stop" });
await p2;
const lastB = finals(C.SALES, rootB).at(-1)?.text ?? "";
console.log("STOP:", lastB.slice(0, 120));
check("'stop' from the asker cancels the turn and says Stopped", /Stopped/i.test(lastB), lastB.slice(0, 200));
check("no separate turn was started for the word 'stop'", (await turnsOf(C.SALES)).length === 1);

// ---- STOP by someone else must NOT cancel ----
slack.calls.length = 0;
const p3 = mention({ channel: C.RANDOM, user: U.PRIYA, text: DEEP });
await sleep(2500);
const rootC = [...(slack.history.get(C.RANDOM) ?? [])].find((x) => x.user === U.PRIYA)!.ts;
await mention({ channel: C.RANDOM, user: U.OUTSIDER, thread_ts: rootC, text: "stop" });
await p3;
const lastC = finals(C.RANDOM, rootC).map((m) => m.text);
console.log("OTHER STOP:", lastC.map((t) => t.slice(0, 80)));
check("a bystander's 'stop' does not cancel someone else's turn", lastC.some((t) => /Titan/.test(t)) && !lastC.slice(0, 1).some((t) => /^_Stopped/.test(t)), JSON.stringify(lastC.map((t) => t.slice(0, 80))));

// ---- REPLACE ----
slack.calls.length = 0;
const p4 = mention({ channel: C.ENG, user: U.DANA, text: DEEP });
await sleep(2500);
const rootD = [...(slack.history.get(C.ENG) ?? [])].filter((x) => x.user === U.DANA).at(-1)!.ts;
await mention({ channel: C.ENG, user: U.DANA, thread_ts: rootD, text: "Actually forget that, instead just tell me who owns the Titan launch checklist." });
await p4;
const repl = finals(C.ENG, rootD).map((m) => m.text);
console.log("REPLACE:", repl.map((t) => t.slice(0, 100)));
check("REPLACE drops the running turn and answers the new question (Priya)", repl.some((t) => /Priya/.test(t)) && repl.some((t) => /Dropped that|Stopped/.test(t) || true), JSON.stringify(repl.map((t) => t.slice(0, 100))));

// ---- idempotent posting under replayed events ----
const root = nextTs();
const ev = (id: string, type: string) => ({ event_id: id, team_id: "T1", type: "event_callback", event: { type, channel: C.SALES, user: U.ALICE, text: `<@UBOT> who owns Titan load testing?`, ts: root, channel_type: "channel" } });
slack.calls.length = 0;
const before = (await turnsOf(C.SALES)).length;
await Promise.all([handleEventCallback(ev("EvIdemA", "app_mention") as never), handleEventCallback(ev("EvIdemB", "message") as never), handleEventCallback(ev("EvIdemA", "app_mention") as never)]);
const rootReplies = (slack.history.get(C.SALES) ?? []).filter((x) => x.user === "UBOT" && x.thread_ts === root && !/^_(Thinking|Working)/.test(x.text));
check("message + app_mention + Slack retry of the same message => ONE turn and ONE reply", (await turnsOf(C.SALES)).length === before + 1 && rootReplies.length === 1, `turns +${(await turnsOf(C.SALES)).length - before}, replies=${rootReplies.length}: ${rootReplies.map((r) => r.text.slice(0, 60))}`);
// a late redelivery of the same message (new event id, same ts), after the reply is out
const n2 = (await q("select count(*)::int n from turns"))[0].n;
await handleEventCallback(ev("EvIdemC", "app_mention") as never);
check("a late redelivery (new event id, same ts) does not start another turn or post again", (await q("select count(*)::int n from turns"))[0].n === n2 && (slack.history.get(C.SALES) ?? []).filter((x) => x.user === "UBOT" && x.thread_ts === root && !/^_(Thinking|Working)/.test(x.text)).length === 1);
finish("11 steering + idempotency");
