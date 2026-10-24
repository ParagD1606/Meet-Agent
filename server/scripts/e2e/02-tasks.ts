// (2) task capture: commitment with owner/assigner/due/permalink, reassignment + done via thread replies, edit/delete sync,
// find_tasks through a REAL runTurn (real model), and a non-member asking about a private-channel task.
import { C, U, check, del, drain, edit, finish, mention, permalink, q, say, setup, slack } from "./harness";
import { settleAmbient } from "../../src/slack/ambient-hook";

await setup();
const tasks = () => q("select id, owner_id, owner_name, assigner_id, text, due_at, status, permalink, scope_tag, channel_id, thread_ts, source_ts from commitments order by created_at");
const show = (rows: any[]) => rows.map((r) => `${r.status} owner=${r.owner_id}/${r.owner_name} by=${r.assigner_id} due=${r.due_at?.toISOString?.().slice(0, 10)} "${r.text}" ${r.permalink}`).join("\n");

// ---- capture ----
const t1 = await say({ at: new Date("2026-10-21T10:00:00Z"), channel: C.ENG, user: U.ALICE, text: `<@${U.PRIYA}> please send the quarterly revenue report to finance by Friday` });
await settleAmbient();
let rows = await tasks();
console.log(show(rows));
check("one commitment captured from the @mention request", rows.length === 1, show(rows));
const r1 = rows[0];
check("owner = Priya", r1?.owner_id === U.PRIYA, `${r1?.owner_id}/${r1?.owner_name}`);
check("assigner = message author (Alice)", r1?.assigner_id === U.ALICE);
check("'by Friday' said on Wed 2026-10-21 -> Fri 2026-10-23", r1?.due_at?.toISOString().startsWith("2026-10-23"), String(r1?.due_at));
check("permalink points at the exact message", r1?.permalink === permalink(C.ENG, t1), r1?.permalink);
check("public channel -> shared scope", r1?.scope_tag === "shared");
check("task text mentions the report", /report/i.test(r1?.text ?? ""), r1?.text);

// idempotent: edit with unchanged text / replay
await edit(C.ENG, t1, U.ALICE, `<@${U.PRIYA}> please send the quarterly revenue report to finance by Friday`);
await settleAmbient();
check("unchanged edit does not duplicate or recreate", (await tasks()).length === 1 && (await tasks())[0].id === r1.id);

// ---- thread reply: reassignment ----
await say({ channel: C.ENG, user: U.DANA, thread_ts: t1, text: "I'll take this one, Priya is swamped with the Titan checklist." });
await settleAmbient();
rows = await tasks();
check("'I'll take this' reassigns to the replier (Dana)", rows[0]?.owner_id === U.DANA && rows.length === 1, show(rows));
await say({ channel: C.ENG, user: U.BOB, thread_ts: t1, text: "Good call. Do we know which finance contact gets it?" });
await settleAmbient();
check("a plain discussion reply changes nothing", (await tasks())[0]?.owner_id === U.DANA && (await tasks())[0]?.status === "open");
// non-owner/non-assigner says done -> must not close
await say({ channel: C.ENG, user: U.BOB, thread_ts: t1, text: "done, shipped it" });
await settleAmbient();
check("a bystander saying 'done' cannot close it", (await tasks())[0]?.status === "open", (await tasks())[0]?.status);
await say({ channel: C.ENG, user: U.DANA, thread_ts: t1, text: "Done, report sent to finance." });
await settleAmbient();
rows = await tasks();
check("owner replying 'done' closes the task", rows[0]?.status === "done", show(rows));
check("done status recorded as a fact in shared scope with link", (await q("select text, scope_tag, permalink from memories where text ilike '%marked done%'")).some((m) => m.scope_tag === "shared" && !!m.permalink), JSON.stringify(await q("select text from memories where text ilike '%done%'")));

// ---- more tasks: private + a second public + delete/edit sync ----
const t2 = await say({ channel: C.EXEC, user: U.ALICE, text: `<@${U.DANA}> please finish the Orion Labs due diligence checklist by 2026-11-10` });
const t3 = await say({ channel: C.SALES, user: U.BOB, text: `I'll send Hallmark Foods the revised contract by tomorrow.` });
const t4 = await say({ channel: C.ENG, user: U.ALICE, text: `<@${U.MAHESH}> please update the pricing page by 2026-11-01` });
await settleAmbient();
rows = await tasks();
console.log(show(rows));
const priv = rows.find((r) => /Orion/i.test(r.text));
check("private-channel task has private scope tag", priv?.scope_tag === `channel_${C.EXEC}` && priv?.owner_id === U.DANA && priv?.due_at?.toISOString().startsWith("2026-11-10"), show(rows));
const own = rows.find((r) => /Hallmark/i.test(r.text));
check("'I'll ...' makes the author the owner AND assigner", own?.owner_id === U.BOB && own?.assigner_id === U.BOB, show(rows));
check("'tomorrow' resolved relative to the message date", !!own?.due_at && Math.abs(own.due_at.getTime() - (Date.now() + 86400_000)) < 2 * 86400_000, String(own?.due_at));
await del(C.ENG, t4);
await settleAmbient();
check("deleting the message drops its task", (await tasks()).find((r) => /pricing page/i.test(r.text))?.status === "dropped", show(await tasks()));
const t5 = await say({ channel: C.ENG, user: U.ALICE, text: `<@${U.MAHESH}> please publish the release notes by 2026-11-04` });
await settleAmbient();
await edit(C.ENG, t5, U.ALICE, `<@${U.BOB}> please publish the release notes by 2026-11-06`);
await settleAmbient();
rows = (await tasks()).filter((r) => /release notes/i.test(r.text));
check("editing the message re-extracts: one active task, new owner and date", rows.length === 1 && rows[0].owner_id === U.BOB && rows[0].due_at?.toISOString().startsWith("2026-11-06"), show(rows));

// ---- find_tasks through the REAL model ----
// asker: Mahesh (in #eng) asks who got the revenue report... that one is done; ask about the contract + release notes
slack.calls.length = 0;
await mention({ channel: C.ENG, user: U.MAHESH, text: "who was given the release notes task and when is it due?" });
const a1 = slack.lastText(C.ENG) ?? "";
console.log("ANSWER 1:", a1);
check("answer names the right owner (Bob / his id) and the date", (/Bob|<@UBOB0004>/.test(a1)) && /Nov(ember)? 6|2026-11-06|6 Nov|6th/i.test(a1), a1);
check("answer includes the Source link of the original message", a1.includes(permalink(C.ENG, t5).replace("https://", "")) || a1.includes(`p${t5.replace(".", "")}`), a1);

slack.calls.length = 0;
await mention({ channel: C.SALES, user: U.PRIYA, text: "who owns sending Hallmark Foods the contract?" });
const a2 = slack.lastText(C.SALES) ?? "";
console.log("ANSWER 2:", a2);
check("second lookup: owner Bob + link", /Bob|<@UBOB0004>/.test(a2) && a2.includes(`p${t3.replace(".", "")}`), a2);

// member of the private channel can see it; an outsider cannot
slack.calls.length = 0;
await mention({ channel: C.EXEC, user: U.ALICE, text: "who was given the Orion Labs due diligence task?" });
const a3 = slack.lastText(C.EXEC) ?? "";
console.log("ANSWER 3:", a3);
check("private-channel member gets owner Dana + link", /Dana|<@UDANA002>/.test(a3) && a3.includes(`p${t2.replace(".", "")}`), a3);

slack.calls.length = 0;
await mention({ channel: C.ENG, user: U.OUTSIDER, text: "who was given the Orion Labs due diligence checklist task?" });
const a4 = slack.lastText(C.ENG) ?? "";
console.log("ANSWER 4 (outsider):", a4);
check("non-member asking in a public channel is told nothing about the private task", !/Dana|UDANA002|GEXEC003|p\d{16}|2026-11-10|Nov(ember)? 10/i.test(a4), a4);

// DM from outsider too
slack.calls.length = 0;
await mention({ channel: "DOUTSIDER", user: U.OUTSIDER, text: "what tasks does Dana have about Orion?", channel_type: "im" });
const a5 = slack.lastText("DOUTSIDER") ?? "";
console.log("ANSWER 5 (outsider DM):", a5);
check("outsider DM also learns nothing", !/Orion.*checklist|due diligence|GEXEC003|2026-11-10/i.test(a5) || /don'?t|no /i.test(a5) && !/due diligence/i.test(a5), a5);
// ---- explicit "@Pixel assign X to @Y and tell him it is urgent" (prod finding: used to store only a fact + consent card) ----
if (process.env.E2E_ASSIGN === "1") { // assign_task is owned by the tasks agent; set E2E_ASSIGN=1 once it lands
slack.calls.length = 0;
const ta = await mention({ channel: C.ENG, user: U.ALICE, text: `assign the task of tales launch to <@${U.BOB}> please and tell him that it is urgent` });
await settleAmbient();
const asg = (await tasks()).filter((r) => /tales launch/i.test(r.text));
console.log(show(asg), "\nREPLY:", slack.reply(C.ENG, ta));
check("assign phrasing creates exactly one commitment", asg.length === 1, show(asg));
check("owner from the @mention, assigner = asker, urgent flagged", asg[0]?.owner_id === U.BOB && asg[0]?.assigner_id === U.ALICE && /urgent/i.test(asg[0]?.text ?? ""), show(asg));
check("source permalink is the asker's message", asg[0]?.permalink === permalink(C.ENG, ta), asg[0]?.permalink);
check("owner in channel is mentioned in the thread with the urgent note", slack.of("chat.postMessage").some((c) => c.args.channel === C.ENG && c.args.text?.includes(`<@${U.BOB}>`) && /urgent/i.test(c.args.text) && c.args.thread_ts === ta), JSON.stringify(slack.of("chat.postMessage").map((c) => c.args.text?.slice(0, 120))));
check("no consent card for a plain assignment", !slack.texts(C.ENG).some((t) => /brain_ask_yes/.test(t)));
slack.calls.length = 0;
const tb = await mention({ channel: C.RANDOM, user: U.PRIYA, text: `assign the vendor invoice review to <@${U.DANA}> by 2026-11-12` });
await settleAmbient();
const asg2 = (await tasks()).find((r) => /vendor invoice/i.test(r.text));
check("owner NOT in channel gets a DM, task stored with due date", asg2?.owner_id === U.DANA && asg2?.due_at?.toISOString().startsWith("2026-11-12") && slack.of("chat.postMessage").some((c) => c.args.channel === `D_${U.DANA}`), show(asg2 ? [asg2] : []) + "\n" + slack.reply(C.RANDOM, tb));
}
finish("02 task capture");
