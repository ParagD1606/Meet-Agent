// Deterministic memory eval cases. Everything is seeded once into one shared corpus (so abstention and ranking face real
// distractors) through addFact with the fake bag-of-words embedder, so it runs offline. Each case has distinctive vocabulary.
import type { SlackScope } from "../../src/memory/scope";

export const CATEGORIES = ["single-hop", "multi-session", "temporal", "knowledge-update", "abstention", "scope-leak", "follow-up", "lookup", "multi-hop", "alias"] as const;
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
  /** Entity mentions the extractor would have emitted for this fact (resolved by addFact: alias / embedding / tie-break). */
  ents?: string[];
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
  /** Thread tail (oldest first) handed to the query rewrite, for follow-ups like "and who signed it?". */
  thread?: string[];
  /** Eval-only: what the stubbed rewrite model returns for this question (the real one is an LLM call). */
  rewrite?: { query: string; asOf?: string };
  /** The top hit must contain this (case-insensitive). */
  first?: string;
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

/** Follow-up: a short message that only makes sense with the thread; the scripted rewrite resolves it, the top hit must be the right entity's fact. */
const follow = (id: number, a: string, b: string, thread: string[], question: string, rewritten: string, first: string): Case =>
  ({ id: `follow-${id}`, category: "follow-up", scope: "pub", seed: [s(a), s(b)], thread, question, rewrite: { query: rewritten }, first });
/** Name/id lookup: the query is (nearly) just an id or a misspelt name; the neighbouring fact differs by one character. */
const lookup = (id: number, a: string, b: string, question: string, first: string): Case =>
  ({ id: `lookup-${id}`, category: "lookup", scope: "pub", seed: [s(a), s(b)], question, first });
/** Time constraint inside the message ("back in February"): the rewrite turns it into asOf. */
const when = (id: number, date: string, question: string, old: [string, string], neu: [string, string], expect: string, stale: string): Case => ({
  ...asOf(id, date, question, old, neu, expect, stale), asOf: undefined, rewrite: { query: question, asOf: date },
});

/** Multi-hop: `a` (person -> group) and `b` (group -> thing) are separate sessions; the question names only b's thing and wants a's person. */
const chain = (id: number, a: [string, string[]], b: [string, string[]], question: string, expect: string): Case =>
  ({ id: `mhop-${id}`, category: "multi-hop", scope: "pub", seed: [{ tag: S, text: a[0], ents: a[1] }, { tag: S, text: b[0], ents: b[1] }], question, expect: [expect] });
/** Alias: each fact names the person differently; the question uses a first name only and needs both facts. */
const alias = (id: number, a: [string, string], b: [string, string], question: string, expect: string[]): Case =>
  ({ id: `alias-${id}`, category: "alias", scope: "pub", seed: [{ tag: S, text: a[0], ents: [a[1]] }, { tag: S, text: b[0], ents: [b[1]] }], question, expect });
/** Entity-expansion leak: public facts share an entity with a private one (which must stay hidden, also as a bridge). */
const entLeak = (id: number, tag: string, text: string, ents: string[], scope: ScopeKey, question: string, secret: string): Case => ({
  id: `entleak-${id}`, category: "scope-leak", scope, question, forbid: [secret],
  seed: [{ tag: S, text: "Marlin codename appears in planning docs", ents: ["Marlin", "Selma Okoye", "Oslo Office"] }, { tag, text, ents }, { tag: S, text: "Oslo Office hosts Marlin sales demo room", ents: ["Oslo Office", "Marlin"] }],
});

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

  // ---- temporal, time constraint parsed from the message by the query rewrite (no explicit asOf) ----
  when(11, "2026-02-20", "What was the Orpheus support lead back in February?", ["The Orpheus support lead is Valentina Cruz", "2026-01-03"], ["The Orpheus support lead is Henrik Dahl", "2026-06-02"], "Valentina Cruz", "Henrik Dahl"),
  when(12, "2026-03-31", "Which warehouse did the Tethys team ship from last quarter?", ["Tethys team ships from the Rotterdam warehouse", "2026-01-15"], ["Tethys team ships from the Gdansk warehouse", "2026-07-01"], "Rotterdam", "Gdansk"),
  when(13, "2026-04-30", "How big was the Calypso pilot cohort before May?", ["The Calypso pilot cohort has 40 customers", "2026-02-10"], ["The Calypso pilot cohort has 120 customers", "2026-08-12"], "40 customers", "120 customers"),

  // ---- follow-up: thread context needed to know what "it" / "that one" / "and the second?" mean ----
  follow(1, "The Kepler contract was signed by Rosalind Ng in March", "The Boreas contract was signed by Ivo Marsh in July", ["user: When does the Kepler contract renew?", "assistant: The Kepler contract renews in December."], "and who signed it?", "Who signed the Kepler contract?", "Rosalind Ng"),
  follow(2, "The Aurora migration is blocked on the DNS cutover", "The Zenith migration is blocked on the vendor audit", ["user: Is the Aurora migration on track?", "assistant: It is delayed."], "why is it delayed?", "Why is the Aurora migration delayed? What is it blocked on?", "DNS cutover"),
  follow(3, "Fenwick Labs pays invoices in euros on net 30 terms", "Gallagher Group pays invoices in dollars on net 60 terms", ["user: Do we invoice Gallagher Group monthly?", "assistant: Yes, monthly."], "what currency and terms do they use?", "What currency and payment terms does Gallagher Group use?", "net 60"),
  follow(4, "The Sirius dashboard refresh runs hourly on the ops cluster", "The Rigel dashboard refresh runs nightly on the analytics cluster", ["user: Tell me about the Rigel dashboard", "assistant: It is the main KPI dashboard."], "and how often does that refresh?", "How often does the Rigel dashboard refresh?", "nightly"),
  follow(5, "Marisol Vega manages the Tidewater account in the east region", "Dmitri Orlov manages the Brackwater account in the west region", ["user: Who looks after the Brackwater account?", "assistant: Let me check."], "and which region is that?", "Which region is the Brackwater account in, who manages it?", "west region"),

  // ---- lookup: ids and misspelt names ----
  lookup(1, "Ticket SUP-7712 was escalated to Orla Quinn for the billing outage", "Ticket SUP-7721 was escalated to Piotr Zajac for the login outage", "SUP-7712", "Orla Quinn"),
  lookup(2, "Bartholomew Quigley owns the Zenith ledger reconciliation", "Bartholomew Quill owns the Meridian invoice archive", "What does Bartholomew Quigly own?", "Zenith ledger"),
  lookup(3, "Deploy ENG-9081 rolled back the payments service at 14:05", "Deploy ENG-9018 promoted the search service at 09:40", "what happened in ENG-9081", "payments service"),
  lookup(4, "Saoirse Gallacher is the escalation contact for Harlow Freight", "Saoirse Gallagher is the escalation contact for Pinecrest Foods", "Who is Saoirse Gallacher the contact for?", "Harlow Freight"),
  lookup(5, "Invoice INV-20877 for Tessellate Corp is overdue by 12 days", "Invoice INV-20778 for Obsidian Corp was paid in full", "INV-20877", "Tessellate Corp"),

  // ---- multi-hop: the answer fact shares no words with the question; it is reachable only through an entity bridge ----
  chain(1, ["Wanjiru Kamau manages the fieldwork squad", ["Wanjiru Kamau", "Fieldwork Squad"]], ["Fieldwork squad owns Pelican app", ["Fieldwork Squad", "Pelican"]], "Who is responsible for Pelican?", "Wanjiru Kamau"),
  chain(2, ["Casimir Dvorak leads the resilience guild", ["Casimir Dvorak", "Resilience Guild"]], ["Resilience guild runs Cormorant postmortems", ["Resilience Guild", "Cormorant"]], "Who is behind the Cormorant follow-ups?", "Casimir Dvorak"),
  chain(3, ["Ayumi Tanabe leads finance for Ember group", ["Ayumi Tanabe", "Ember Group"]], ["Ember group funds Ledger Console", ["Ember Group", "Ledger Console"]], "Who controls the budget for the Ledger Console?", "Ayumi Tanabe"),
  chain(4, ["Bjorn Halvorsen sponsors the Basalt initiative", ["Bjorn Halvorsen", "Basalt Initiative"]], ["Basalt initiative covers Equinox campaign", ["Basalt Initiative", "Equinox"]], "Which executive stands behind Equinox?", "Bjorn Halvorsen"),
  chain(5, ["Thandiwe Mokoena handles security for Larkspur Dental", ["Thandiwe Mokoena", "Larkspur Dental"]], ["Larkspur Dental joined Foxglove program", ["Larkspur Dental", "Foxglove Program"]], "Who handles security for the Foxglove Program customers?", "Thandiwe Mokoena"),
  chain(6, ["Radoslav Petrov holds pager for platform reliability crew", ["Radoslav Petrov", "Platform Reliability Crew"]], ["Platform reliability crew operates Osprey pipeline", ["Platform Reliability Crew", "Osprey"]], "Who gets paged when Osprey breaks?", "Radoslav Petrov"),

  // ---- alias resolution: one person written differently across sessions; both facts must be found from either name ----
  alias(1, ["Dana Schmidt owns the Orchid vendor contract", "Dana Schmidt"], ["D. Schmidt signed the Orchid renewal for 2027", "D. Schmidt"], "What has Dana done on Orchid?", ["Orchid vendor contract", "Orchid renewal for 2027"]),
  alias(2, ["Noor Haddad approved the Wisteria billing plan", "Noor Haddad"], ["N. Haddad moved the Wisteria invoice run to Fridays", "N. Haddad"], "What is Noor responsible for at Wisteria?", ["Wisteria billing plan", "invoice run to Fridays"]),
  alias(3, ["Soren Lindgren carries the ferry pager this month", "Soren Lindgren"], ["S. Lindgren wrote the ferry incident runbook", "S. Lindgren"], "What is Soren doing with the ferry?", ["ferry pager", "incident runbook"]),
  alias(4, ["Marguerite Dubois owns the tenancy compliance checklist", "Marguerite Dubois"], ["M. Dubois revised the checklist template in Q3", "M. Dubois"], "What does Marguerite handle for tenancy reviews?", ["tenancy compliance checklist", "template in Q3"]),
  alias(5, ["Chidi Nwosu owns Tern product", "Chidi Nwosu"], ["C. Nwosu cut Tern scope for winter release", "C. Nwosu"], "What has Chidi decided about Tern?", ["owns Tern product", "winter release"]),

  // ---- scope-leak through entity expansion: a private fact shares an entity with public ones; it must not surface, nor bridge ----
  entLeak(1, "channel_C_PB", "The Marlin takeover price is 14 million dollars", ["Marlin"], "pub", "Tell me about Marlin", "14 million"),
  entLeak(2, "channel_C_PA", "Selma Okoye will be laid off from the Marlin division in Q3", ["Selma Okoye", "Marlin"], "pub", "What is happening with Selma Okoye?", "laid off"),
  entLeak(3, "user_U1", "My salary for the Marlin role is 200 thousand", ["Marlin"], "dm2", "What do we know about Marlin?", "200 thousand"),
  entLeak(4, "channel_C_PB", "Marlin hides a bribery investigation in Oslo", ["Marlin", "Oslo Office"], "privA", "Anything on the Marlin Oslo Office?", "bribery"),
];
