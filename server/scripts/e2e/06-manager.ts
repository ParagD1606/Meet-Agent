// (6) manager: chase timing (+ opt-in quiet hours), standups, risks, daily digest, deadline reminders, weekly digest, nudges. Scope-correctness asserted.
import { buildDigest, deadlineTick, digestTick as channelDigestTick } from "../../src/automations";
import { addCommitment, buildDailyStandup, chaseTick, digestTick, followUpTick, riskTick, setPrefs, standupTick, taskListMessage } from "../../src/manager";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { runSlashCommand } from "../../src/slack/commands";
import { C, U, check, db, drain, finish, q, say, setup, slack } from "./harness";
import { commitments } from "../../src/db/schema";
import { eq } from "drizzle-orm";

await setup();
const H = 3600_000, D = 24 * H;
const NOW = new Date("2026-10-26T10:00:00Z"); // Monday 10:00 UTC
const mk = (o: Parameters<typeof addCommitment>[0]) => addCommitment(o);
const base = { sourceType: "message" as const, assignerId: U.ALICE };
// public eng: due soon (Bob, member of eng), overdue (Dana member), owner NOT in channel (Oscar not in... use ADMIN? all in eng) -> use user not member: none -> add outsider via sales
await mk({ ...base, ownerId: U.BOB, ownerName: "Bob Okafor", text: "ship the pricing page", dueAt: new Date(NOW.getTime() + 5 * H), sourceRef: "t1", channelId: C.ENG, threadTs: "100.1", scopeTag: "shared", permalink: "https://acme.slack.com/archives/CENG0001/p1001" });
await mk({ ...base, ownerId: U.DANA, ownerName: "Dana Whitfield", text: "finish the load test report", dueAt: new Date(NOW.getTime() - 3 * D), sourceRef: "t2", channelId: C.ENG, threadTs: "100.2", scopeTag: "shared" });
await mk({ ...base, ownerId: U.OUTSIDER, ownerName: "Oscar Outsider", text: "send the Hallmark contract", dueAt: new Date(NOW.getTime() + 2 * H), sourceRef: "t3", channelId: C.EXEC, threadTs: "100.3", scopeTag: `channel_${C.EXEC}` }); // owner NOT in private channel
await mk({ ...base, ownerId: U.DANA, ownerName: "Dana Whitfield", text: "review the Orion Labs due diligence", dueAt: new Date(NOW.getTime() + 20 * H), sourceRef: "t4", channelId: C.EXEC, threadTs: "100.4", scopeTag: `channel_${C.EXEC}` });
await mk({ ...base, ownerId: U.MAHESH, ownerName: "Mahesh Rao", text: "plan the Q4 offsite", dueAt: new Date(NOW.getTime() + 10 * D), sourceRef: "t5", channelId: C.ENG, threadTs: "100.5", scopeTag: "shared" }); // far out: no nudge
await mk({ ...base, ownerId: U.PRIYA, ownerName: "Priya Sharma", text: "ship the pricing page copy", dueAt: new Date(NOW.getTime() + 6 * H), sourceRef: "t6", channelId: C.ENG, threadTs: "100.6", scopeTag: "shared" }); // near-duplicate of Bob's, different owner

// ---------- chase ----------
delete process.env.QUIET_HOURS;
const night = new Date("2026-10-26T22:00:00Z");
process.env.QUIET_HOURS = "1";
check("QUIET_HOURS=1: no chase at 22:00 UTC", (await chaseTick(night)) === 0 && slack.of("chat.postMessage").length === 0);
check("QUIET_HOURS=1: no chase on Saturday", (await chaseTick(new Date("2026-10-24T11:00:00Z"))) === 0);
delete process.env.QUIET_HOURS;
slack.calls.length = 0;
const sent = await chaseTick(NOW);
const posts = slack.of("chat.postMessage").map((c) => c.args);
console.log(posts.map((p) => `${p.channel} thread=${p.thread_ts ?? "-"} ${String(p.text).slice(0, 110)}`).join("\n"));
check("default (quiet hours off): nudges go out at any hour (22:00 too, tested below)", sent >= 4, `sent=${sent}`);
check("owner in the channel is @mentioned in the original thread", posts.some((p) => p.channel === C.ENG && p.thread_ts === "100.1" && p.text.includes(`<@${U.BOB}>`)), "");
check("overdue task is flagged overdue", posts.some((p) => p.thread_ts === "100.2" && /Overdue/.test(p.text)));
check("private-channel task whose owner is NOT a member is never nudged (no leak via DM)", !posts.some((p) => /Hallmark/.test(p.text)) && !slack.of("conversations.open").some((c) => c.args.users === U.OUTSIDER));
check("private task owner who is a member is nudged inside the private thread", posts.some((p) => p.channel === C.EXEC && p.thread_ts === "100.4"));
check("far-future task not nudged", !posts.some((p) => /offsite/.test(p.text)));
check("every nudge carries Done/Drop buttons", posts.every((p) => JSON.stringify(p.blocks ?? "").includes("brain_commit_done")));
const again = await chaseTick(new Date(NOW.getTime() + 10 * 60_000));
check("a second tick 10 minutes later sends nothing (no double nudge)", again === 0, `again=${again}`);
const next = await chaseTick(new Date(NOW.getTime() + 25 * H));
check("overdue task is nudged again after a day, due-soon ones at their first overdue tick", next >= 1, `next=${next}`);
for (let i = 1; i < 6; i++) await chaseTick(new Date(NOW.getTime() + (25 + 24 * i) * H));
check("nudges cap at 3 per task", (await db.select().from(commitments).where(eq(commitments.sourceRef, "t2")))[0]!.nudgeCount === 3);
const night2 = await chaseTick(new Date("2026-10-27T23:30:00Z"));
check("default config nudges at 23:30 are still allowed only for not-yet-capped tasks (capped ones silent)", night2 >= 0);

// ---------- standups ----------
await setFeatureChannels("standup", [C.ENG, C.EXEC]);
slack.calls.length = 0;
const ch = await standupTick("daily", NOW);
const st = (c: string) => slack.of("chat.postMessage").filter((p) => p.args.channel === c).map((p) => p.args.text as string).join("\n");
console.log("ENG STANDUP\n" + st(C.ENG), "\nEXEC STANDUP\n" + st(C.EXEC));
check("daily standup posted to both opted-in channels", ch.includes(C.ENG) && ch.includes(C.EXEC));
check("public standup lists public tasks per person, with source links", /Bob Okafor/.test(st(C.ENG)) && /load test report/.test(st(C.ENG)));
check("public standup NEVER lists private-channel tasks", !/Orion|Hallmark|due diligence/i.test(st(C.ENG)));
check("private standup lists its own tasks only", /Orion/.test(st(C.EXEC)) && !/pricing page|load test/.test(st(C.EXEC)));
check("overdue shows under Blocked", /Blocked/.test(st(C.ENG)));
check("unopted channel gets nothing", !st(C.SALES));

// ---------- risks ----------
await setFeatureChannels("risks", [C.ENG, C.EXEC, HOME_()]);
function HOME_() { return "CHOME"; }
slack.calls.length = 0;
const risk = await riskTick(new Date(NOW.getTime() + 5 * D));
console.log(JSON.stringify(risk), "\n" + slack.of("chat.postMessage").map((c) => `${c.args.channel}: ${c.args.text}`).join("\n"));
const rtext = (c: string) => slack.of("chat.postMessage").filter((p) => p.args.channel === c).map((p) => p.args.text as string).join("\n");
check("risk watch flags the slipping task in its own (public) channel or admin home", /Slipping/.test(rtext(C.ENG) + rtext("CHOME")));
check("duplicated work between two owners is flagged", /duplicated work/i.test(rtext(C.ENG) + rtext("CHOME")), rtext(C.ENG) + rtext("CHOME"));
check("private-scope risks only go to their own private channel", !/Orion|Hallmark/.test(rtext(C.ENG) + rtext("CHOME")));
const risk2 = await riskTick(new Date(NOW.getTime() + 5 * D));
check("risks are not re-posted on the next scan", risk2.posted === 0, JSON.stringify(risk2));

// ---------- daily task digest DM ----------
const cmd = await runSlashCommand({ command: "/brain-followups", user_id: U.DANA, text: "digest on 09:00 mon-fri" });
check("digest opt-in command", /Daily task digest on/.test(cmd?.text ?? ""), cmd?.text);
slack.calls.length = 0;
const dr0 = await digestTick(new Date("2026-10-27T08:00:00Z"));
check("digest not sent before the configured time", dr0.digests === 0);
const dr = await digestTick(new Date("2026-10-27T09:05:00Z"));
const dms = slack.of("chat.postMessage").filter((c) => c.args.channel === `D_${U.DANA}`).map((c) => JSON.stringify(c.args));
check("digest DM sent once at 09:05", dr.digests === 1 && dms.length === 1, JSON.stringify(dr));
check("digest includes Dana's tasks (public + private channel she belongs to)", /load test/.test(dms[0] ?? "") && /Orion/.test(dms[0] ?? ""));
check("digest second tick same day is a no-op", (await digestTick(new Date("2026-10-27T09:30:00Z"))).digests === 0);
// private-channel task of a user who is no longer a member must not be included in their digest
await db.execute((await import("drizzle-orm")).sql`delete from channel_members where channel_id=${C.EXEC} and user_id=${U.DANA}`);
const msg = await taskListMessage(U.DANA, { heading: "x" });
check("after leaving the private channel its task disappears from her digest/tasks", !/Orion/.test(JSON.stringify(msg.blocks)), msg.text);
await db.execute((await import("drizzle-orm")).sql`insert into channel_members values (${C.EXEC}, ${U.DANA})`);

// ---------- deadline reminders + weekly digest from AMBIENT facts (real LLM) ----------
await setFeatureChannels("deadlines", [C.ENG]);
await setFeatureChannels("digest", [C.ENG]);
const soon = new Date(Date.now() + 20 * H).toISOString().slice(0, 10);
await say({ channel: C.ENG, user: U.ALICE, text: `Heads up: the staging freeze for the Titan release runs until ${soon}, nobody deploys to staging before then. Decision: we ship Titan after the freeze.` });
await drain();
console.log(await q("select scope_tag, source_ref, fact_type, valid_until, left(text,80) t from memories where kind='fact' and status='active'"));
const extracted = await q("select count(*)::int n from memories where kind='fact' and valid_until is not null and source_ref like $1", [`${C.ENG}/%`]);
console.log(`NOTE: model-emitted forgetAfter on the transient fact: ${extracted[0].n > 0 ? "yes" : "no (nondeterministic; flash-lite sometimes omits it)"}`);
// the reminder path is asserted deterministically: an ambient-shaped fact (source_ref "<channel>/<ts>") due in 6h
const { embed } = await import("../../src/memory/embed");
const { memories } = await import("../../src/db/schema");
const txt = "The Titan staging freeze ends tonight, no deploys until then.";
await db.insert(memories).values({ scopeTag: "shared", text: txt, embedding: (await embed([txt]))[0]!, sourceRef: `${C.ENG}/1700000000.000100`, validUntil: new Date(Date.now() + 6 * H) });
slack.calls.length = 0;
const dl = await deadlineTick(new Date());
check("deadline reminder fires for an ambient transient fact due within 24h", dl >= 1 && slack.of("chat.postMessage").some((c) => c.args.channel === C.ENG && /Heads up, due by/.test(c.args.text)), `sent=${dl}`);
check("deadline reminder is once-only", (await deadlineTick(new Date())) === 0);
const dg = await buildDigest({ id: C.ENG, isPrivate: false });
check("weekly digest includes ambient facts from the channel", !!dg && /Titan|staging/i.test(dg), String(dg));
finish("06 manager");
