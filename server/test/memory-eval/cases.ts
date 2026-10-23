// Deterministic memory eval cases. Everything is seeded once into one shared corpus (so abstention and ranking face real
// distractors) through addFact with the fake bag-of-words embedder, so it runs offline. Each case has distinctive vocabulary.
import type { SlackScope } from "../../src/memory/scope";

export const CATEGORIES = ["single-hop", "multi-session", "temporal", "knowledge-update", "abstention", "scope-leak"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Who is asking. dm1/dm2 are DMs with U1/U2; U1 belongs to private channel C_PA, U2 to C_PB. */
export const SCOPES = {
  pub: { channelId: "C_PUB", isPrivate: false, isIm: false, userId: "U1" },
  privA: { channelId: "C_PA", isPrivate: true, isIm: false, userId: "U1" },
  privB: { channelId: "C_PB", isPrivate: true, isIm: false, userId: "U2" },
  dm1: { channelId: "D1", isPrivate: false, isIm: true, userId: "U1" },
  dm2: { channelId: "D2", isPrivate: false, isIm: true, userId: "U2" },
} satisfies Record<string, SlackScope>;
export type ScopeKey = keyof typeof SCOPES;

export const CHANNELS = [
  { id: "C_PUB", isPrivate: false, isIm: false, members: [] as string[] },
  { id: "C_PA", isPrivate: true, isIm: false, members: ["U1"] },
  { id: "C_PB", isPrivate: true, isIm: false, members: ["U2"] },
  { id: "D1", isPrivate: false, isIm: true, members: ["U1"] },
  { id: "D2", isPrivate: false, isIm: true, members: ["U2"] },
];

export type Seed = {
  tag: string;
  text: string;
  /** ISO date the fact became true (default: now). */
  at?: string;
  /** Eval-only: the stubbed contradiction check supersedes existing facts whose text includes this. */
  replaces?: string;
};
export type Case = {
  id: string;
  category: Category;
  scope: ScopeKey;
  seed: Seed[];
  question: string;
  /** Every substring must appear in a top-k hit (case-insensitive). */
  expect?: string[];
  /** None of these may appear in any hit; "*" means no hit at all (abstention). */
  forbid?: string[];
  asOf?: string;
};

const S = "shared";
const s = (text: string, at?: string): Seed => ({ tag: S, text, at });
const hop = (id: number, seed: string, question: string, expect: string): Case =>
  ({ id: `hop-${id}`, category: "single-hop", scope: "pub", seed: [s(seed)], question, expect: [expect] });
const multi = (id: number, a: string, b: string, question: string, ea: string, eb: string): Case =>
  ({ id: `multi-${id}`, category: "multi-session", scope: "pub", seed: [s(a), s(b)], question, expect: [ea, eb] });
const update = (id: number, old: string, neu: string, question: string, expect: string, stale: string): Case => ({
  id: `update-${id}`, category: "knowledge-update", scope: "pub", question, expect: [expect], forbid: [stale],
  seed: [s(old, "2026-01-10"), { ...s(neu, "2026-06-10"), replaces: stale }],
});
/** As-of question: `old` was true until `neu` replaced it; asking as of a date between them must return only `old`. */
const asOf = (id: number, date: string, question: string, old: [string, string], neu: [string, string], expect: string, stale: string): Case => ({
  id: `temporal-${id}`, category: "temporal", scope: "pub", question, asOf: date, expect: [expect], forbid: [stale],
  seed: [s(old[0], old[1]), { ...s(neu[0], neu[1]), replaces: expect }],
});
const none = (id: number, question: string): Case => ({ id: `abstain-${id}`, category: "abstention", scope: "pub", seed: [], question, forbid: ["*"] });
const leak = (id: number, tag: string, text: string, scope: ScopeKey, question: string, secret: string): Case =>
  ({ id: `leak-${id}`, category: "scope-leak", scope, seed: [{ tag, text }], question, forbid: [secret] });

export const CASES: Case[] = [
  // ---- single-hop: one fact answers the question ----
  hop(1, "The billing owner for Zephyr Corp is Priya Sharma", "Who is the billing owner for Zephyr Corp?", "Priya Sharma"),
  hop(2, "The Orion renewal deadline is 2026-11-15", "When is the Orion renewal deadline?", "2026-11-15"),
  hop(3, "Our staging database runs on Postgres 16 in the eu-west region", "Which Postgres version does the staging database run?", "Postgres 16"),
  hop(4, "The on-call rotation for payments is handled by Mateo Ruiz this week", "Who handles the payments on-call rotation?", "Mateo Ruiz"),
  hop(5, "Quasar project budget is 480 thousand dollars for fiscal 2026", "What is the Quasar project budget?", "480 thousand"),
  hop(6, "The design system lives in the Figma file called Lumen Foundations", "Where does the design system live in Figma?", "Lumen Foundations"),
  hop(7, "Refunds above 500 dollars need approval from the finance lead Hana Ito", "Who approves refunds above 500 dollars?", "Hana Ito"),
  hop(8, "The Nimbus API rate limit is 1200 requests per minute per tenant", "What is the Nimbus API rate limit?", "1200 requests"),
  hop(9, "Weekly retrospective for the growth squad happens on Thursdays at 15:30", "When is the growth squad retrospective?", "Thursdays at 15:30"),
  hop(10, "The vendor for office coffee is Bluebird Roasters on a quarterly contract", "Which vendor supplies office coffee?", "Bluebird Roasters"),
  hop(11, "Security incidents must be reported to the channel secops-alerts within one hour", "Where do security incidents get reported?", "secops-alerts"),
  hop(12, "Tamsin Okafor is the engineering manager of the mobile platform team", "Who manages the mobile platform team?", "Tamsin Okafor"),
  hop(13, "The Helix migration cutover is planned for the second weekend of March", "When is the Helix migration cutover?", "second weekend of March"),
  hop(14, "Customer Vandelay Industries pays by wire transfer with net 45 terms", "What payment terms does Vandelay Industries have?", "net 45"),

  // ---- multi-session: the answer needs facts learned in separate sessions ----
  multi(1, "Luca Moretti joined the infrastructure team in April", "The infrastructure team owns the Kestrel deployment pipeline", "Who joined the team that owns the Kestrel deployment pipeline?", "Luca Moretti", "Kestrel deployment pipeline"),
  multi(2, "Project Mercury is sponsored by the CFO Dana Whitfield", "Project Mercury kickoff is scheduled for the first Monday of September", "Who sponsors Project Mercury and when is its kickoff?", "Dana Whitfield", "first Monday of September"),
  multi(3, "Brightside Dental signed the enterprise plan with 250 seats", "Brightside Dental contact for security reviews is Ines Barros", "What plan did Brightside Dental sign and who handles their security reviews?", "250 seats", "Ines Barros"),
  multi(4, "The Atlas dashboard reads from the warehouse table fact_orders", "The warehouse table fact_orders is refreshed nightly at 02:00 UTC", "How often is the data behind the Atlas dashboard refreshed?", "fact_orders", "02:00 UTC"),
  multi(5, "Oskar Lindqvist leads the hiring panel for senior backend roles", "The senior backend interview loop has four rounds including a system design session", "Who leads hiring for senior backend roles and what does the loop include?", "Oskar Lindqvist", "four rounds"),
  multi(6, "The Poseidon outage on May 3 was triggered by an expired TLS certificate", "The Poseidon outage postmortem action item is automated certificate rotation owned by Reza Tehrani", "What triggered the Poseidon outage and who owns the follow-up?", "expired TLS certificate", "Reza Tehrani"),
  multi(7, "Marketing launches the Solstice campaign on LinkedIn and podcasts", "The Solstice campaign target is 3000 qualified leads by the end of the quarter", "Where does the Solstice campaign run and what is its lead target?", "LinkedIn and podcasts", "3000 qualified leads"),
  multi(8, "Customer Initech reported slow exports in ticket SUP-4412", "Slow exports for Initech were traced to a missing index on the reports table", "What caused Initech's slow exports ticket?", "SUP-4412", "missing index"),
  multi(9, "Anneliese Fischer owns the vendor security questionnaire process", "The vendor security questionnaire template was last revised in the Q2 compliance review", "Who owns the vendor security questionnaire and when was the template revised?", "Anneliese Fischer", "Q2 compliance review"),
  multi(10, "The Granite feature flag service is written in Go", "Granite stores flag state in Redis with a 30 second cache TTL", "What language is the Granite flag service written in and how long is its cache TTL?", "written in Go", "30 second"),

  // ---- temporal: "as of" questions (asOf) must see the fact that was true then, not the later one ----
  asOf(1, "2026-02-15", "Who was the Jupiter account lead in February?", ["The Jupiter account lead is Camila Duarte", "2026-01-05"], ["The Jupiter account lead is Jonas Weber", "2026-05-20"], "Camila Duarte", "Jonas Weber"),
  asOf(2, "2026-03-20", "What was the Saturn support tier price in March?", ["Saturn support tier costs 90 dollars per seat", "2026-01-01"], ["Saturn support tier costs 120 dollars per seat", "2026-04-15"], "90 dollars", "120 dollars"),
  asOf(3, "2026-01-25", "Which office was the Pegasus team based in during January?", ["The Pegasus team is based in the Lisbon office", "2025-11-01"], ["The Pegasus team is based in the Berlin office", "2026-03-01"], "Lisbon", "Berlin"),
  asOf(4, "2026-04-10", "What was the Draco on-call policy last spring?", ["Draco on-call policy is a weekly handoff on Mondays", "2026-01-12"], ["Draco on-call policy is a daily follow-the-sun handoff", "2026-08-01"], "weekly handoff", "follow-the-sun"),
  asOf(5, "2026-05-30", "Which CRM did sales use before June?", ["Sales tracks all deals in the Pipedrive CRM", "2025-09-01"], ["Sales tracks all deals in the Salesforce CRM", "2026-06-15"], "Pipedrive", "Salesforce"),
  asOf(6, "2026-07-20", "What was the Vega release version in July?", ["Vega release version is 2.3", "2026-06-01"], ["Vega release version is 3.0", "2026-09-01"], "2.3", "3.0"),
  asOf(7, "2026-01-31", "Who was the Lyra product owner at the start of the year?", ["The Lyra product owner is Beatrix Novak", "2025-12-01"], ["The Lyra product owner is Emeka Obi", "2026-07-01"], "Beatrix Novak", "Emeka Obi"),
  asOf(8, "2026-02-28", "What was the Hydra maintenance window in February?", ["Hydra maintenance window is Sundays 01:00 to 03:00", "2026-01-01"], ["Hydra maintenance window is Wednesdays 22:00 to midnight", "2026-05-01"], "Sundays 01:00", "Wednesdays"),
  asOf(9, "2026-05-15", "Who was the Cygnus escalation contact in May?", ["The Cygnus escalation contact is Farah Haddad", "2026-02-01"], ["The Cygnus escalation contact is Tobias Klein", "2026-08-10"], "Farah Haddad", "Tobias Klein"),
  // facts that are both valid at the asked date: the future one must not leak in
  { id: "temporal-10", category: "temporal", scope: "pub", question: "What did we decide about the Corvus hiring freeze in April?", asOf: "2026-04-30", expect: ["April 8"], forbid: ["September 2"],
    seed: [s("The Corvus hiring freeze was announced on April 8", "2026-04-08"), s("The Corvus hiring freeze exceptions were approved on September 2", "2026-09-02")] },

  // ---- knowledge-update: the current fact must win and the stale one must not be returned ----
  update(1, "The Andromeda billing owner is Priya Raman", "The Andromeda billing owner is now Dana Lee", "Who is the Andromeda billing owner?", "Dana Lee", "Priya Raman"),
  update(2, "The Titan launch date is set for 2026-03-01", "The Titan launch date moved to 2026-09-15", "What is the Titan launch date?", "2026-09-15", "2026-03-01"),
  update(3, "Our Phoenix support hours are 9am to 5pm Eastern", "Our Phoenix support hours are now 8am to 8pm Eastern", "What are the Phoenix support hours?", "8am to 8pm", "9am to 5pm"),
  update(4, "The Mirage team standup is at 09:00 on weekdays", "The Mirage team standup moved to 10:30 on weekdays", "When is the Mirage team standup?", "10:30", "09:00"),
  update(5, "Cobalt cloud spend limit is 20 thousand dollars monthly", "Cobalt cloud spend limit was raised to 35 thousand dollars monthly", "What is the Cobalt cloud spend limit?", "35 thousand", "20 thousand"),
  update(6, "The Delta project repository is hosted on Bitbucket", "The Delta project repository migrated to GitHub", "Where is the Delta project repository hosted?", "GitHub", "Bitbucket"),
  update(7, "Ember customer success is led by Gareth Pugh", "Ember customer success is now led by Sunita Rao", "Who leads Ember customer success?", "Sunita Rao", "Gareth Pugh"),
  update(8, "The Fjord expense policy caps meals at 40 dollars", "The Fjord expense policy now caps meals at 65 dollars", "What does the Fjord expense policy cap meals at?", "65 dollars", "40 dollars"),
  update(9, "Glacier backups are retained for 14 days", "Glacier backups are now retained for 90 days", "How long are Glacier backups retained?", "90 days", "14 days"),
  update(10, "The Harbor onboarding checklist has 8 steps", "The Harbor onboarding checklist was trimmed to 5 steps", "How many steps are in the Harbor onboarding checklist?", "5 steps", "8 steps"),

  // ---- abstention: nothing in memory is relevant, nothing should come back ----
  none(1, "What is the name of the CEO's pet iguana?"),
  none(2, "Which volcano erupted near the Reykjavik datacenter?"),
  none(3, "How many moons does Neptune have according to the astronomy club?"),
  none(4, "What is the secret recipe for the cafeteria lasagna?"),
  none(5, "Who won the 1998 chess tournament in Tbilisi?"),
  none(6, "What is the wifi password at the Osaka hotel?"),
  none(7, "Which marathon did the intern Wilhelmina run in Reykjanes?"),
  none(8, "What colour is the CTO's sailboat?"),
  none(9, "Summarise the zoology department grant proposal on axolotls."),
  none(10, "What did the board decide about the lunar base lease?"),

  // ---- scope-leak: facts from another scope must never be recalled ----
  leak(1, "channel_C_PB", "The Barracuda acquisition target is Meridian Robotics at 9 million", "pub", "What is the Barracuda acquisition target?", "Meridian Robotics"),
  leak(2, "channel_C_PB", "Layoff plan for the Kraken division affects 40 roles in Q1", "privA", "What is the Kraken division layoff plan?", "40 roles"),
  leak(3, "channel_C_PA", "Compensation bands for the Leviathan staff engineers start at 310 thousand", "privB", "What are the Leviathan staff engineer compensation bands?", "310 thousand"),
  leak(4, "user_U2", "Personal note: my performance review with Griffin is on Tuesday", "dm1", "When is my performance review with Griffin?", "performance review with Griffin"),
  leak(5, "user_U1", "Personal note: I am interviewing at Manticore Labs next week", "pub", "Is anyone interviewing at Manticore Labs?", "Manticore Labs"),
  leak(6, "channel_C_PB", "Whistleblower complaint about the Chimera vendor was filed by legal", "dm1", "Was a complaint filed about the Chimera vendor?", "Whistleblower complaint"),
  leak(7, "user_U1", "My private goal is to move to the Sphinx platform team by June", "dm2", "What is the goal about the Sphinx platform team?", "Sphinx platform team"),
  leak(8, "channel_C_PA", "Settlement figure for the Hydrangea lawsuit is 2.4 million", "pub", "What is the settlement figure for the Hydrangea lawsuit?", "2.4 million"),
  // positive control: a DM legitimately reads its user's private channels
  { id: "leak-9", category: "scope-leak", scope: "dm1", seed: [{ tag: "channel_C_PA", text: "The Wyvern budget memo is stored in the private finance folder" }],
    question: "Where is the Wyvern budget memo stored?", expect: ["private finance folder"] },
];
