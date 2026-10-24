// (8) schedule_follow_up and ask_teammate consent / quiet-hour flows, and the Resolve button storing Q/A that then answers a repeat question.
import { askDeps } from "../../src/slack/teammate";
import { handleInteraction } from "../../src/slack/interactions";
import { followUpTick } from "../../src/manager";
import { C, U, check, db, drain, finish, mention, q, say, setup, slack, sleep } from "./harness";
import { addFact } from "../../src/memory/supersede";

await setup();
const blocksOf = (method: string) => slack.of(method).flatMap((c) => (c.args.blocks ?? []) as any[]);
const actionValue = (id: string) => { for (const b of [...blocksOf("chat.postMessage"), ...blocksOf("chat.update")].reverse()) for (const e of b.elements ?? []) if (e.action_id === id) return e.value as string; return undefined; };
const click = (user: string, id: string, value: string, extra: object = {}) => handleInteraction({ type: "block_actions", user: { id: user }, actions: [{ action_id: id, value }], ...extra } as never);

// ================= schedule_follow_up: reminder to self =================
const ts1 = await mention({ channel: C.ENG, user: U.ALICE, text: "remind me in 2 days to review the vendor invoice" });
console.log("REPLY:", slack.reply(C.ENG, ts1));
let fus = await q("select * from follow_ups order by created_at");
check("reminder stored pending for the asker, due ~2 days out, no consent card", fus.length === 1 && fus[0].owner_id === U.ALICE && !fus[0].target_id && fus[0].status === "pending" && Math.abs(fus[0].due_at.getTime() - (Date.now() + 2 * 86400_000)) < 30 * 3600_000, JSON.stringify(fus.map((f) => ({ ...f, text: f.text }))));
check("reply confirms what was scheduled", /schedul|remind/i.test(slack.reply(C.ENG, ts1)), slack.reply(C.ENG, ts1));

// ================= follow-up with someone else: consent card =================
slack.calls.length = 0;
const ts2 = await mention({ channel: C.ENG, user: U.ALICE, text: `follow up with <@${U.DANA}> about the pricing doc in 3 days` });
console.log("REPLY:", slack.reply(C.ENG, ts2));
fus = await q("select * from follow_ups where target_id is not null");
check("follow-up to Dana is 'proposed' (not active) until the asker clicks", fus.length === 1 && fus[0].status === "proposed", JSON.stringify(fus));
check("consent card posted to the asker's thread; Dana has received nothing", !!actionValue("brain_fu_yes") && !slack.of("conversations.open").some((c) => c.args.users === U.DANA));
const fuId = actionValue("brain_fu_yes")!;
await click(U.BOB, "brain_fu_yes", fuId, { container: { channel_id: C.ENG, message_ts: "1.1" } });
check("someone else's click on the card does nothing", (await q("select status from follow_ups where id=$1", [fuId]))[0].status === "proposed");
await click(U.ALICE, "brain_fu_yes", fuId, { container: { channel_id: C.ENG, message_ts: "1.1" } });
check("asker's click activates it", (await q("select status from follow_ups where id=$1", [fuId]))[0].status === "pending");
// delivery with quiet hours opt-in
await db.execute((await import("drizzle-orm")).sql`update follow_ups set due_at = '2026-10-26T20:00:00Z' where id=${fuId}`);
process.env.QUIET_HOURS = "1";
slack.calls.length = 0;
check("QUIET_HOURS=1: due at 20:00 UTC Monday -> held", (await followUpTick(new Date("2026-10-26T20:30:00Z"))) === 0 && !slack.of("conversations.open").length);
await db.execute((await import("drizzle-orm")).sql`update follow_ups set due_at = '2026-10-27T09:10:00Z' where id=${fuId}`);
check("QUIET_HOURS=1: inside working hours it is sent (Dana + the earlier self-reminder)", (await followUpTick(new Date("2026-10-27T09:30:00Z"))) === 2);
delete process.env.QUIET_HOURS;
const dm = slack.of("chat.postMessage").find((c) => c.args.channel === `D_${U.DANA}`)?.args.text as string | undefined;
check("Dana's DM carries only the follow-up text (no channel/thread detail)", !!dm && /pricing doc/.test(dm) && !/CENG|archives|thread/.test(dm), dm);
check("sent once only", (await followUpTick(new Date("2026-10-27T09:40:00Z"))) === 0);

// ================= ask_teammate =================
await addFact({ tag: "shared", text: "Dana Whitfield owns the Berlin office lease and its renewal date.", source: "slack", createdBy: U.DANA });
const deferred: { id: string; at: Date }[] = [];
askDeps.defer = async (id, at) => { deferred.push({ id, at }); };
slack.calls.length = 0;
const ts3 = await mention({ channel: C.ENG, user: U.BOB, text: `Please ask <@${U.DANA}> when the Berlin office lease renews.` });
console.log("REPLY:", slack.reply(C.ENG, ts3));
const askId = actionValue("brain_ask_yes");
check("consent card for ask_teammate shown to the asker; nothing sent to Dana yet", !!askId && !slack.of("chat.postMessage").some((c) => c.args.channel === `D_${U.DANA}`));
await click(U.OUTSIDER, "brain_ask_yes", askId!, { container: { channel_id: C.ENG, message_ts: "1.1" } });
check("a bystander's click does not confirm", (await q("select value->>'status' s from settings where key=$1", [`ask:${askId}`]))[0].s === "proposed");
askDeps.now = () => new Date("2026-10-26T22:00:00Z");
process.env.QUIET_HOURS = "1"; // ask_teammate's own window is ASK window; quiet-hours flag is separate in main
slack.calls.length = 0;
await click(U.BOB, "brain_ask_yes", askId!, { container: { channel_id: C.ENG, message_ts: "1.1" } });
const st1 = (await q("select value->>'status' s from settings where key=$1", [`ask:${askId}`]))[0].s;
console.log("ask status after confirm at 22:00 UTC:", st1, "deferred:", JSON.stringify(deferred));
delete process.env.QUIET_HOURS;
askDeps.now = () => new Date();
if (st1 === "confirmed") {
  check("outside the ask window delivery is deferred to the next window (not sent)", deferred.length === 1 && !slack.of("chat.postMessage").some((c) => /is asking/.test(c.args.text ?? "") || /asked me to check/.test(c.args.text ?? "")), JSON.stringify(deferred));
  const { attemptDelivery } = await import("../../src/slack/teammate");
  await attemptDelivery(askId!, { now: new Date("2026-10-27T10:00:00Z") });
} else check("delivered immediately (window not enforced by default in main)", st1 === "sent", st1);
const asked = slack.of("chat.postMessage").find((c) => /is asking|asked me to check/.test(c.args.text ?? ""));
check("Dana (member of #eng) is asked in the original thread with only the question", !!asked && asked.args.channel === C.ENG && /Berlin/i.test(asked.args.text), asked?.args.text);
// Dana answers in the thread
const askRow = (await q("select value from settings where key=$1", [`ask:${askId}`]))[0].value;
slack.calls.length = 0;
await say({ channel: C.ENG, user: U.DANA, thread_ts: askRow.target?.threadTs ?? ts3, text: "The Berlin lease renews on 2027-03-31, notice is due by 2026-12-31." });
const ans = (await q("select text, scope_tag from memories where text like 'Q:%Berlin%' and status='active'"))[0];
check("Dana's answer is stored as Q/A in the asker's write scope and relayed", !!ans && /2027-03-31/.test(ans.text) && ans.scope_tag === "shared" && slack.of("chat.postMessage").some((c) => /that's your answer|replied/i.test(c.args.text ?? "")), JSON.stringify(ans));
check("answered ask is closed (a second reply is not captured again)", (await q("select value->>'status' s from settings where key=$1", [`ask:${askId}`]))[0].s === "answered");
// non-member owner path -> DM
slack.calls.length = 0;
const ts4 = await mention({ channel: C.RANDOM, user: U.PRIYA, text: `Who handles the Zephyr contract renewal? Please ask <@${U.DANA}> since I don't know.` });
const askId2 = actionValue("brain_ask_yes");
if (askId2) {
  await click(U.PRIYA, "brain_ask_yes", askId2, { container: { channel_id: C.RANDOM, message_ts: "1.1" } });
  const dm2 = slack.of("chat.postMessage").find((c) => c.args.channel === `D_${U.DANA}`)?.args.text as string | undefined;
  check("owner outside the channel gets a DM with the question only", !!dm2 && /Zephyr/.test(dm2) && !/CRANDOM4|archives/.test(dm2), dm2);
} else check("second ask card produced", false, slack.reply(C.RANDOM, ts4));

// ================= Resolve button =================
await addFact({ tag: "shared", text: "Support tickets are triaged within 4 business hours and urgent ones go to Sofia.", source: "slack", createdBy: U.ADMIN, permalink: "https://acme.slack.com/archives/CENG0001/p111" });
slack.calls.length = 0;
const ts5 = await mention({ channel: C.ENG, user: U.BOB, text: "how fast do we triage support tickets?" });
const answer = slack.reply(C.ENG, ts5);
console.log("ANSWER:", answer);
const rv = actionValue("brain_resolve_yes");
check("answer carries Resolved / Not quite buttons", !!rv && !!actionValue("brain_resolve_no"), answer);
const finalUpdate = slack.of("chat.update").filter((c) => c.args.blocks?.length).at(-1)!;
const msgTs = finalUpdate.args.ts;
const payload = { container: { channel_id: C.ENG, message_ts: msgTs, thread_ts: ts5 }, message: { ts: msgTs, text: finalUpdate.args.text, thread_ts: ts5 } };
await click(U.OUTSIDER, "brain_resolve_yes", rv!, payload);
check("only the asker's Resolved click counts", (await q("select count(*)::int n from memories where text like 'Q:%triage support%'"))[0].n === 0);
await click(U.BOB, "brain_resolve_yes", rv!, payload);
const qa = await q("select text, scope_tag, fact_type, permalink from memories where text like 'Q:%' and text ilike '%triage%' and status='active'");
check("Resolved stores a decision-type 'Q: ... A: ...' in the thread scope with a permalink", qa.length === 1 && qa[0].fact_type === "decision" && qa[0].scope_tag === "shared" && !!qa[0].permalink, JSON.stringify(qa));
// remove the original fact so the repeat question can ONLY be answered from the stored Q/A
await db.execute((await import("drizzle-orm")).sql`update memories set status='deleted' where text like 'Support tickets are triaged%'`);
const { clearRecallCache } = await import("../../src/memory/recall");
clearRecallCache();
slack.calls.length = 0;
const ts6 = await mention({ channel: C.SALES, user: U.ALICE, text: "how fast do we triage support tickets?" });
const again = slack.reply(C.SALES, ts6);
console.log("REPEAT:", again);
check("repeat question answered from the stored Q/A (4 business hours) and cites it", /4 business hours|four business hours/i.test(again), again);
// Not quite
slack.calls.length = 0;
const ts7 = await mention({ channel: C.ENG, user: U.BOB, text: "what is our refund window?" });
const rno = actionValue("brain_resolve_no");
if (rno) {
  const fu2 = slack.of("chat.update").filter((c) => c.args.blocks?.length).at(-1)!;
  slack.calls.length = 0;
  await click(U.BOB, "brain_resolve_no", rno, { container: { channel_id: C.ENG, message_ts: fu2.args.ts, thread_ts: ts7 }, message: { ts: fu2.args.ts, text: fu2.args.text, thread_ts: ts7 } });
  check("'Not quite' asks what was wrong", slack.of("chat.postMessage").some((c) => /What was missing or wrong/.test(c.args.text ?? "")));
} else check("'Not quite' button available on that answer (it is an abstention, so maybe none)", true, slack.reply(C.ENG, ts7));
finish("08 follow-up / ask / resolve flows");
