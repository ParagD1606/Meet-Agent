// (1) ambient capture through the real event handlers: facts, scope tags, permalinks, dedupe, supersede, secrets, pause/resume, opt-out.
import { runSlashCommand } from "../../src/slack/commands";
import { C, U, activeFacts, check, db, del, drain, dump, edit, facts, finish, handleEventCallback, permalink, q, say, setup, slack } from "./harness";

await setup();

// ---- realistic public chat (#eng) ----
await say({ channel: C.ENG, user: U.ALICE, text: "Morning all. Quick sync on Titan: we decided to launch Titan on 2026-11-02, Priya owns the launch checklist." });
await say({ channel: C.ENG, user: U.PRIYA, text: "Confirmed. I'll have the checklist ready, and Dana is handling the load testing for Titan." });
await say({ channel: C.ENG, user: U.BOB, text: "lol nice" });
await say({ channel: C.ENG, user: U.DANA, text: "FYI our staging DB password is hunter2-staging-2026 please don't share, and the deploy token is ghp_abcdefghijklmnop1234567890" });
await say({ channel: C.ENG, user: U.MAHESH, text: "Pricing update: the Team plan is now $49 per seat per month, approved by Alice last Tuesday." });
await say({ channel: C.ENG, user: U.BOB, text: "Heads up, Zephyr Corp is our design partner for the Titan beta and their main contact is Jo Lindqvist." });
// ---- private exec channel ----
await say({ channel: C.EXEC, user: U.ALICE, text: "Confidential: we are in acquisition talks with Orion Labs, the board approved a ceiling of $4M." });
await say({ channel: C.EXEC, user: U.DANA, text: "Agreed. Legal counsel for the Orion Labs deal is Fenwick, kickoff call is 2026-11-05." });
const n1 = await drain();
const f1 = await activeFacts();
console.log(dump(f1));
check("facts extracted from public + private chat", n1 >= 4, `stored ${n1}`);
const pub = f1.filter((f) => f.scope_tag === "shared");
const priv = f1.filter((f) => f.scope_tag === `channel_${C.EXEC}`);
check("public chat -> shared tag", pub.some((f) => /Titan/i.test(f.text) && /2026-11-02/.test(f.text)), dump(pub));
check("pricing fact captured with number", pub.some((f) => /\$49/.test(f.text)), dump(pub));
check("private chat -> channel_<id> tag only", priv.length >= 1 && priv.every((f) => /Orion/i.test(f.text)), dump(priv));
check("private content never in shared", !pub.some((f) => /Orion|\$4M|acquisition/i.test(f.text)), dump(pub));
check("no other tag exists", f1.every((f) => f.scope_tag === "shared" || f.scope_tag === `channel_${C.EXEC}`), [...new Set(f1.map((f) => f.scope_tag))].join(","));
check("secrets dropped (password / token)", !f1.some((f) => /hunter2|ghp_|password/i.test(f.text)), "no fact mentions them");
check("trivial chatter dropped", !f1.some((f) => /lol nice/i.test(f.text)));
check("no raw slack ids / mention tokens in facts", !f1.some((f) => /<@|\bU[A-Z0-9]{7,}\b/.test(f.text)), dump(f1.filter((f) => /<@|\bU[A-Z0-9]{7,}\b/.test(f.text))));
const withLink = f1.filter((f) => f.permalink);
check("every ambient fact carries a permalink to the source channel", withLink.length === f1.length && f1.every((f) => f.permalink!.startsWith(`https://acme.slack.com/archives/${f.scope_tag === "shared" ? C.ENG : C.EXEC}/p`)), f1.map((f) => f.permalink).join("\n"));
check("ambient notice posted once per channel", slack.texts(C.ENG).filter((t) => /I learn from what's said/.test(t)).length === 1 && slack.texts(C.EXEC).filter((t) => /I learn from what's said/.test(t)).length === 1);
check("the plain-id ledger holds the text no more (text cleared after extraction)", (await q("select count(*)::int n from ambient_messages where text <> ''"))[0].n === 0);

// ---- dedupe: replayed Slack event (same ts, same event) and a literal repeat ----
const before = (await facts()).length;
const ts = await say({ channel: C.ENG, user: U.MAHESH, text: "Pricing update: the Team plan is now $49 per seat per month, approved by Alice last Tuesday." });
await handleEventCallback({ event_id: "EvREPLAY", team_id: "T1", type: "event_callback", event: { type: "message", channel: C.ENG, user: U.MAHESH, text: "Pricing update: the Team plan is now $49 per seat per month, approved by Alice last Tuesday.", ts, channel_type: "channel" } });
await handleEventCallback({ event_id: "EvREPLAY", team_id: "T1", type: "event_callback", event: { type: "message", channel: C.ENG, user: U.MAHESH, text: "x", ts, channel_type: "channel" } });
await drain();
const after = (await facts()).length;
check("repeated identical message / replayed event adds no duplicate fact", after === before, `facts before=${before} after=${after}\n${dump((await facts()).filter((f) => /\$49/.test(f.text)))}`);

// ---- supersede on a changed decision ----
await say({ channel: C.ENG, user: U.ALICE, text: "Update: Titan launch slipped, we are now launching Titan on 2026-11-16 because the SOC2 audit needs two more weeks." });
await drain();
const titan = await facts(`text ilike '%titan%' and text ~ 'launch'`);
console.log(dump(titan));
const oldF = titan.find((f) => /2026-11-02/.test(f.text));
const newF = titan.find((f) => /2026-11-16/.test(f.text));
check("new Titan date stored active", !!newF && newF.status === "active", dump(titan));
check("old Titan date superseded (not active)", !!oldF && oldF.status === "superseded" && oldF.superseded_by === newF?.id, dump(titan));
const tg = await q(`select scope_tag, status from memories where id = $1`, [oldF?.id ?? -1]);
check("superseded row kept as history (never hard deleted)", tg.length === 1);

// ---- edit & delete sync ----
const t2 = await say({ channel: C.SALES, user: U.BOB, text: "We closed the Hallmark Foods deal for $12k annual, starting 2026-12-01." });
await drain();
check("sales message produced a fact", (await activeFacts("shared")).some((f) => /Hallmark/i.test(f.text)));
await del(C.SALES, t2);
check("deleting the source message retires its fact", !(await activeFacts("shared")).some((f) => /Hallmark/i.test(f.text)), dump(await facts(`text ilike '%Hallmark%'`)));

// ---- pause / resume / opt-out ----
const asMember = await runSlashCommand({ command: "/brain-pause", user_id: U.BOB, channel_id: C.ENG });
check("non-admin cannot pause", /Only workspace admins/.test(asMember?.text ?? ""), asMember?.text);
const forged = await runSlashCommand({ command: "/brain-pause", user_id: "UFORGED99", channel_id: C.ENG });
check("unknown/forged user cannot pause", /Only workspace admins/.test(forged?.text ?? ""), forged?.text);
const paused = await runSlashCommand({ command: "/brain-pause", user_id: U.ADMIN, channel_id: C.ENG });
check("admin pauses", /Paused/.test(paused?.text ?? ""), paused?.text);
const beforeP = (await facts()).length;
await say({ channel: C.ENG, user: U.PRIYA, text: "While paused: we decided the Atlas rebrand budget is $90k, signed off by Alice." });
const n = await drain();
check("paused channel learns nothing", n === 0 && (await facts()).length === beforeP && !(await facts()).some((f) => /Atlas/i.test(f.text)));
const resumed = await runSlashCommand({ command: "/brain-resume", user_id: U.ADMIN, channel_id: C.ENG });
check("resume works", /Resumed/.test(resumed?.text ?? ""), resumed?.text);
await say({ channel: C.ENG, user: U.PRIYA, text: "After resume: we decided the Borealis offsite will be in Lisbon in 2027-02, Priya is booking it." });
await drain();
check("resumed channel learns again", (await activeFacts("shared")).some((f) => /Borealis|Lisbon/i.test(f.text)), dump(await activeFacts("shared")));
check("text said while paused was never stored", !(await facts()).some((f) => /Atlas/i.test(f.text)));
await db.execute((await import("drizzle-orm")).sql`update channels set observe=false where id=${C.RANDOM}`);
await say({ channel: C.RANDOM, user: U.PRIYA, text: "We decided the Cobalt hackathon winners get a $500 voucher each, funded by Mahesh." });
await drain();
check("opt-out channel (observe=false) learns nothing", !(await facts()).some((f) => /Cobalt/i.test(f.text)));

// ---- DMs never ambient ----
await say({ channel: "DPRIYA1", user: U.PRIYA, text: "Between us: we decided the Delta layoff plan will be announced 2026-12-12 by the CEO." , channel_type: "im" });
await drain(["DPRIYA1"]);
check("DM text is not captured ambiently", !(await facts()).some((f) => /Delta layoff/i.test(f.text)));
check("no ambient rows for a DM", (await q("select count(*)::int n from ambient_messages where channel_id='DPRIYA1'"))[0].n === 0);

// ---- edit of an already-extracted single-message batch ----
const t3 = await say({ channel: C.ENG, user: U.DANA, text: "Decision: the on-call rotation lead for November is Bob, rotation starts 2026-11-03." });
await drain();
const hadBob = (await activeFacts("shared")).some((f) => /on-call/i.test(f.text) && /Bob/.test(f.text));
await edit(C.ENG, t3, U.DANA, "Decision: the on-call rotation lead for November is Priya, rotation starts 2026-11-03.");
await drain();
const af = await activeFacts("shared");
check("edit re-extracts: old value retired and new value present", hadBob && !af.some((f) => /on-call/i.test(f.text) && /Bob/.test(f.text)) && af.some((f) => /on-call/i.test(f.text) && /Priya/.test(f.text)), dump(af.filter((f) => /on-call/i.test(f.text))));
finish("01 ambient capture");
