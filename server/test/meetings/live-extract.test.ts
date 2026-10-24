// Real-model measurement of the unified final pass (LIVE_MODEL=1). Four synthetic transcripts with gold tasks:
// precision / recall of tasks, owner and due accuracy, label accuracy, and how many AUTO-ASSIGNED items (threshold 0.6) were wrong.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { users } from "../../src/db/schema";
import { extractMeeting } from "../../src/meetings/analyze";
import { autoApproves, type MeetingItem } from "../../src/meetings/items";
import { setMemoryLlm } from "../../src/memory/llm";

const LIVE = process.env.LIVE_MODEL === "1";
const live = (LIVE ? (name: string, fn: () => Promise<void>) => test(name, fn, { timeout: 600_000 }) : test.skip) as (name: string, fn: () => Promise<void>) => void;

const PEOPLE = { Dana: "UDANA", Parag: "UPARAG", Eve: "UEVE", Manas: "UMANAS", Priya: "UPRIYA" } as const;
type Gold = { re: RegExp; owner: keyof typeof PEOPLE | null; due: (string | null)[] | "any"; label: ("confirmed" | "tentative" | "suggestion")[]; optional?: boolean };
type Case = { name: string; ref: string; text: string; tasks: Gold[]; decisions: number; questions: number };

const CASES: Case[] = [
  { name: "launch planning (Monday)", ref: "2026-10-19T15:00:00Z", decisions: 1, questions: 1, text: `Dana: Alright everyone, thanks for joining. Let's lock down the launch plan for Tales.
Parag: Quick update, the landing page copy is nearly done. I'll send it over to Eve for review by Wednesday.
Eve: Sounds good, I'll review it as soon as I get it.
Dana: Great. Manas, can you take the pricing page? We need it live before the launch.
Manas: Yeah, I'll handle the pricing page, should have it done by Friday.
Dana: Perfect. Next, the press release. Priya, you're on that, please send a draft to me by Tuesday.
Priya: Got it, draft by Tuesday.
Eve: We could maybe do a short teaser video too, if there's budget.
Dana: Let's see, not committing to that yet.
Dana: One decision: we're going with the October 30th launch date, not November.
Parag: Do we know who is paying for the ad spend? That's still open.
Dana: Nobody has answered that yet. Let's park it.
Dana: Someone should also check that the legal footer is in the template.
Manas: I'll check the legal footer today, it's quick.
Dana: Okay. That's it, thanks all.`,
  tasks: [
    { re: /landing|copy/i, owner: "Parag", due: ["2026-10-21"], label: ["confirmed"] },
    { re: /review/i, owner: "Eve", due: [null], label: ["confirmed", "tentative"] },
    { re: /pricing/i, owner: "Manas", due: ["2026-10-23"], label: ["confirmed"] },
    { re: /press|release|draft/i, owner: "Priya", due: ["2026-10-20"], label: ["confirmed"] },
    { re: /legal|footer/i, owner: "Manas", due: ["2026-10-19"], label: ["confirmed"] },
    { re: /teaser|video/i, owner: null, due: [null], label: ["suggestion"], optional: true },
  ] },
  { name: "engineering retro, lowercase ASR text (Thursday)", ref: "2026-10-22T16:00:00Z", decisions: 1, questions: 1, text: `priya: ok so the deploy last night failed because the migration script was running twice
manas: yeah that was me, i'll write a guard so it can't run twice, i'll have the pr up tomorrow
dana: good. parag can you update the runbook with the rollback steps? by end of week would be great
parag: sure will do, friday
eve: i think we should maybe switch to blue green deploys at some point but that's a bigger discussion
dana: agreed lets put that on the backlog not now
dana: decision, we freeze deploys on fridays starting next week
priya: who owns the on call rotation for november? nobody has said
dana: good question, we need to sort that out, i don't have the answer
eve: i'll look into the monitoring alerts, they were noisy, i can have a summary monday
manas: also could someone ask the vendor about the staging credits
dana: i'll follow up with the vendor about staging credits this week`,
  tasks: [
    { re: /guard|migration/i, owner: "Manas", due: ["2026-10-23"], label: ["confirmed"] },
    { re: /runbook|rollback/i, owner: "Parag", due: ["2026-10-23"], label: ["confirmed"] },
    { re: /monitor|alert/i, owner: "Eve", due: ["2026-10-26"], label: ["confirmed"] },
    { re: /vendor|staging|credits/i, owner: "Dana", due: [null, "2026-10-23"], label: ["confirmed"] },
    { re: /blue.?green/i, owner: null, due: [null], label: ["suggestion"], optional: true },
  ] },
  { name: "sales call, hedges and misspelled names (Wednesday)", ref: "2026-10-21T14:00:00Z", decisions: 1, questions: 1, text: `dana: thanks for joining. recap of the acme deal: they want a custom onboarding.
paraag: i can probably get the security questionnaire back to them, i'll try for monday
dana: eve, you own the contract redlines. get those to legal by thursday.
evie: ok thursday, on it.
dana: we will need a discount approval from finance, someone has to ask them.
manas: not sure that's my area, maybe priya?
priya: i can ask finance, i'll message them after lunch
dana: pricing, we decided to offer 10 percent off for annual prepay, final.
dana: what is the timeline for their legal review? they didn't say.
manas: i might look at the integration docs if i have time
dana: okay no pressure`,
  tasks: [
    { re: /questionnaire|security/i, owner: "Parag", due: ["2026-10-26"], label: ["tentative", "confirmed"] },
    { re: /redline|contract/i, owner: "Eve", due: ["2026-10-22"], label: ["confirmed"] },
    { re: /finance|discount/i, owner: "Priya", due: ["2026-10-21", null], label: ["confirmed"] },
    { re: /integration|docs/i, owner: "Manas", due: [null], label: ["tentative", "suggestion"], optional: true },
  ] },
  { name: "standup with small items (Friday)", ref: "2026-10-23T09:00:00Z", decisions: 1, questions: 0, text: `dana: quick standup. parag?
parag: finished the analytics export. today i'll start on the dashboard filters, should take two days.
eve: i'm blocked on design assets. dana can you ping the design agency?
dana: yes i'll ping them right after this call.
manas: i'll review parag's pr this afternoon.
priya: nothing blocking. i'll write the release notes for 4.2 by monday.
dana: eve, once the assets come in please update the homepage.
dana: ok and a reminder, the quarterly planning doc is due next friday and nobody has picked it up.
dana: we decided to move standup to 10am starting next week.`,
  tasks: [
    { re: /dashboard|filter/i, owner: "Parag", due: "any", label: ["confirmed"] },
    { re: /agency|design/i, owner: "Dana", due: ["2026-10-23"], label: ["confirmed"] },
    { re: /review.*pr|parag's pr|pr\b/i, owner: "Manas", due: ["2026-10-23"], label: ["confirmed"] },
    { re: /release notes/i, owner: "Priya", due: ["2026-10-26"], label: ["confirmed"] },
    { re: /homepage/i, owner: "Eve", due: [null, "any"] as never, label: ["confirmed", "tentative"] },
  ] },
];

beforeAll(async () => {
  if (!LIVE) return;
  setMemoryLlm(null);
  await resetDb();
  await db.insert(users).values(Object.entries(PEOPLE).map(([name, id]) => ({ id, name })));
});
afterAll(() => setMemoryLlm(null));

live("final pass on four synthetic meetings: precision / recall / owner / due / label / wrong auto-assignments", async () => {
  const roster = Object.entries(PEOPLE).map(([name, id]) => ({ id, name }));
  const tot = { gold: 0, found: 0, items: 0, ownerOk: 0, ownerN: 0, dueOk: 0, dueN: 0, labelOk: 0, labelN: 0, auto: 0, autoWrong: 0, dec: 0, decGold: 0, q: 0, qGold: 0, unowned: 0 };
  const report: unknown[] = [];
  for (const c of CASES) {
    const ex = await extractMeeting(c.text, { roster, names: roster.map((r) => r.name), ref: new Date(c.ref) });
    const tasks = ex.items.filter((i) => i.itemType === "task");
    const used = new Set<string>();
    const matchOf = (g: Gold): MeetingItem | undefined => tasks.find((t) => !used.has(t.id) && g.re.test(`${t.title} ${t.description} ${t.quote}`) && (g.owner === null || t.assigneeId === PEOPLE[g.owner])) ?? tasks.find((t) => !used.has(t.id) && g.re.test(`${t.title} ${t.quote}`));
    const rows = c.tasks.map((g) => {
      const m = matchOf(g);
      if (m) used.add(m.id);
      return { g, m };
    });
    const required = rows.filter((r) => !r.g.optional);
    tot.gold += required.length; tot.found += required.filter((r) => r.m).length;
    for (const { g, m } of required) {
      if (!m) continue;
      tot.ownerN++; if (m.assigneeId === (g.owner ? PEOPLE[g.owner] : null)) tot.ownerOk++;
      if (g.due !== "any" && !(Array.isArray(g.due) && g.due.includes("any" as never))) { tot.dueN++; if ((g.due as (string | null)[]).includes(m.dueDate)) tot.dueOk++; }
      tot.labelN++; if (g.label.includes(m.label as never) || (m.kind === "commitment" && g.label.includes("confirmed") && m.label === "confirmed")) tot.labelOk++;
    }
    // every extracted task item: is it something in the gold list (required or optional)?
    tot.items += tasks.filter((t) => t.kind === "commitment").length;
    const auto = tasks.filter((t) => autoApproves(t, "auto", 0.6));
    tot.auto += auto.length;
    const wrong = auto.filter((t) => { const r = rows.find((x) => x.m?.id === t.id); return !r || r.g.owner === null || t.assigneeId !== PEOPLE[r.g.owner]; });
    tot.autoWrong += wrong.length;
    tot.dec += Math.min(c.decisions, ex.items.filter((i) => i.itemType === "decision").length); tot.decGold += c.decisions;
    tot.q += Math.min(c.questions, ex.items.filter((i) => i.itemType === "question").length); tot.qGold += c.questions;
    tot.unowned += tasks.filter((t) => !t.assigneeId).length;
    report.push({ meeting: c.name, extracted: tasks.map((t) => `${t.assigneeName ?? "-"} | ${t.title} | due ${t.dueDate ?? "-"} | ${t.kind}/${t.label} ${t.confidence.toFixed(2)}${t.unverified ? " UNVERIFIED" : ""}${autoApproves(t, "auto", 0.6) ? " AUTO" : ""}`), missed: required.filter((r) => !r.m).map((r) => String(r.g.re)), wrongAuto: wrong.map((t) => `${t.assigneeName} | ${t.title}`) });
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "n/a");
  const summary = {
    taskRecall: pct(tot.found, tot.gold), taskPrecision_commitmentItemsMatched: pct(tot.found, tot.items), ownerAccuracy: pct(tot.ownerOk, tot.ownerN), dueAccuracy: pct(tot.dueOk, tot.dueN), labelAccuracy: pct(tot.labelOk, tot.labelN),
    autoAssigned: tot.auto, autoAssignedWrong: tot.autoWrong, autoAssignedPrecision: pct(tot.auto - tot.autoWrong, tot.auto), decisionsFound: pct(tot.dec, tot.decGold), questionsFound: pct(tot.q, tot.qGold),
  };
  console.log("LIVE_EXTRACT_REPORT", JSON.stringify({ summary, report }, null, 1));
  expect(tot.found / tot.gold).toBeGreaterThanOrEqual(0.75); // recall
  expect(tot.ownerOk / Math.max(1, tot.ownerN)).toBeGreaterThanOrEqual(0.85);
  expect(tot.autoWrong).toBeLessThanOrEqual(1);
});

live("a date that is restated in the meeting is kept as a visible conflict, the latest value wins", async () => {
  const roster = Object.entries(PEOPLE).map(([name, id]) => ({ id, name }));
  const text = `dana: parag, can you send the kessler contract by friday?
parag: yes, friday works, i'll send the kessler contract.
dana: wait, legal needs another pass first. let's make it monday instead.
parag: ok, monday then.`;
  const ex = await extractMeeting(text, { roster, names: roster.map((r) => r.name), ref: new Date("2026-10-21T14:00:00Z") });
  const t = ex.items.filter((i) => i.itemType === "task" && /kessler|contract/i.test(i.title));
  console.log("LIVE_RESTATE", JSON.stringify(t.map((i) => ({ due: i.dueDate, owner: i.assigneeName, conflicts: i.ambiguity.conflicts }))));
  expect(t).toHaveLength(1);
  expect(t[0]!.dueDate).toBe("2026-10-26");
  expect(t[0]!.ambiguity.conflicts.some((c) => c.type === "due" && c.restated && c.with.dueDate === "2026-10-23")).toBe(true);
});
