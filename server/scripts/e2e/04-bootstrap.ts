// (4) core-block bootstrap for channels and users with the real LLM; human-written lines are preserved; scope-correct.
import { bootstrapChannel, bootstrapIfEmpty, bootstrapUser } from "../../src/memory/bootstrap";
import { coreMemoryEdit, getCoreBlocks } from "../../src/memory/core-blocks";
import { rememberFact } from "../../src/memory/facts";
import { C, U, check, drain, finish, mention, q, say, setup, slack } from "./harness";

await setup();
slack.purposes.set(C.ENG, "Engineering discussion: launches, deploys, on-call");
const chat: [string, string, string][] = [
  [C.ENG, U.ALICE, "Decision: we launch Titan on 2026-11-02 and Priya owns the launch checklist."],
  [C.ENG, U.DANA, "We decided to deploy every Tuesday and Thursday, and Dana owns load testing."],
  [C.ENG, U.BOB, "Our staging database is reset every Sunday night, please plan around it."],
  [C.EXEC, U.ALICE, "Confidential: the board approved acquisition talks with Orion Labs, ceiling $4M."],
  [C.EXEC, U.DANA, "Legal counsel for the Orion Labs deal is Fenwick, kickoff 2026-11-05."],
];
for (const [c, u, t] of chat) await say({ channel: c, user: u, text: t });
await drain();
console.log(await q("select scope_tag, source_ref, left(text,70) t from memories where kind='fact' and status='active'"));

// human-written lines first
const human = { userId: U.ALICE, role: "member" as const, agentContext: "primary" as const };
await coreMemoryEdit({ scope: { channelId: C.ENG, isPrivate: false, isIm: false, userId: U.ALICE }, actor: human, label: "channel", op: "add", text: "Norm: post incidents in this channel, never in DMs." });
await coreMemoryEdit({ scope: { channelId: C.EXEC, isPrivate: true, isIm: false, userId: U.ALICE }, actor: human, label: "channel", op: "add", text: "Norm: exec decisions are logged by Alice." });
await coreMemoryEdit({ scope: { channelId: C.ENG, isPrivate: false, isIm: true, userId: U.PRIYA }, actor: { userId: U.PRIYA, role: "member", agentContext: "primary" }, label: "user", op: "add", text: "Prefers short Friday summaries." });
await rememberFact({ tag: `user_${U.PRIYA}`, text: "Priya prefers design reviews as written docs.", source: "slack", createdBy: U.PRIYA, agentContext: "primary" });

const blk = async (c: string, p: boolean) => (await getCoreBlocks({ channelId: c, isPrivate: p, isIm: false, userId: U.ALICE })).channel!.text;
const r1 = await bootstrapChannel(C.ENG);
console.log("ENG:", JSON.stringify(r1), "\n" + (await blk(C.ENG, false)));
check("public channel About written", r1.status === "written" && !!r1.line, JSON.stringify(r1));
const eng1 = await blk(C.ENG, false);
check("About reflects the channel's ambient facts, not only its purpose (Titan / Tuesday / staging)", /Titan|Tuesday|Thursday|staging|load test/i.test(r1.line ?? ""), r1.line);
check("human line preserved", eng1.includes("Norm: post incidents in this channel, never in DMs."), eng1);
check("About is a single line (no duplicates)", eng1.split("\n").filter((l) => l.startsWith("About: ")).length === 1);
check("public About never mentions private exec content", !/Orion|acquisition|\$4M|Fenwick/i.test(eng1), eng1);
const r1b = await bootstrapChannel(C.ENG);
check("second run: still exactly one About line + human line kept", (await blk(C.ENG, false)).split("\n").filter((l) => l.startsWith("About: ")).length === 1 && (await blk(C.ENG, false)).includes("Norm:"), JSON.stringify(r1b));

const r2 = await bootstrapChannel(C.EXEC);
const exec = await blk(C.EXEC, true);
console.log("EXEC:", JSON.stringify(r2), "\n" + exec);
check("private channel About written from its own facts", r2.status === "written" && /Orion|acquisition|legal|board/i.test(exec), exec);
check("private channel About does not contain public-channel facts", !/Titan|Tuesday|staging/i.test(r2.line ?? ""), r2.line);
check("private human line preserved", exec.includes("Norm: exec decisions are logged by Alice."));
check("private block content stays under the private tag only", (await q("select scope_tag from core_blocks where text like '%Orion%'")).every((r) => r.scope_tag === `channel_${C.EXEC}`));

const ru = await bootstrapUser(U.PRIYA);
const prof = (await getCoreBlocks({ channelId: C.ENG, isPrivate: false, isIm: false, userId: U.PRIYA })).user!.text;
console.log("USER:", JSON.stringify(ru), "\n" + prof);
check("user Profile written", ru.status === "written" && /Priya/.test(prof), prof);
check("user human line preserved", prof.includes("Prefers short Friday summaries."), prof);
check("user profile uses own-scope fact (written docs)", /written doc|design review/i.test(prof), prof);
check("user profile never includes private channel content", !/Orion|Fenwick|\$4M/.test(prof));

// hook: first mention by a brand-new user builds the block in the background
await mention({ channel: C.ENG, user: U.MAHESH, text: "hi, who owns the Titan launch checklist?" });
await new Promise((r) => setTimeout(r, 4000));
const mp = (await q("select text from core_blocks where scope_tag=$1 and label='user'", [`user_${U.MAHESH}`]))[0]?.text ?? "";
check("first mention bootstraps the asker's Profile line", /^Profile: /m.test(mp), mp);
// idempotent if-empty
await bootstrapIfEmpty(`channel:${C.ENG}`);
check("bootstrapIfEmpty does not rewrite an existing About", (await blk(C.ENG, false)).includes("Norm:"));
finish("04 core-block bootstrap");
