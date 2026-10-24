// (14) freshness fast mode timings with real timers + real LLM, and run-now endpoints single-flight / rate limit with the REAL runners.
import { app } from "../../src/app";
import { createSession } from "../../src/auth/session";
import { getFreshness, saveFreshness, setFreshnessMode, tuning } from "../../src/memory/freshness";
import { resetRunNow } from "../../src/memory/run-now";
import { C, U, check, db, finish, mention, q, say, setup, sleep, slack } from "./harness";

await setup();
const sess = await createSession(null, U.ADMIN);
const adminCookie = `brain_session=${sess}`;
const memberCookie = `brain_session=${await createSession(null, U.BOB)}`;
const call = (method: string, path: string, cookie: string | undefined, body?: unknown) =>
  app.request(path, { method, headers: { ...(cookie ? { cookie } : {}), "x-requested-with": "fetch", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const factCount = async (like: string) => (await q("select count(*)::int n from memories where kind='fact' and status='active' and text ilike $1", [like]))[0].n;
const waitFact = async (like: string, maxMs: number) => { const t0 = Date.now(); while (Date.now() - t0 < maxMs) { if ((await factCount(like)) > 0) return Date.now() - t0; await sleep(500); } return -1; };

// ---- settings API ----
check("freshness setting is admin only", (await call("GET", "/api/settings/memory-freshness", memberCookie)).status === 403);
check("starts in normal mode (5 min idle flush)", getFreshness() === "normal" && tuning().idleMs === 300_000 && tuning().captureEvery === 3);

// ---- normal: ambient message is NOT extracted within 20s ----
await say({ channel: C.ENG, user: U.ALICE, text: "Decision: the Helios beta opens to customers on 2026-11-20, owned by Priya." });
const normalMs = await waitFact("%Helios%", 20_000);
check("normal mode: nothing learned within 20s (debounced to 5 minutes)", normalMs === -1, `learned after ${normalMs}ms`);
// run-now capture-flush flushes it immediately
const flush = await call("POST", "/api/memory/run", adminCookie, { job: "capture-flush" });
const fj: any = await flush.json();
const flushed = await waitFact("%Helios%", 5_000);
check("run-now 'capture-flush' learns the buffered message at once", flush.status === 200 && flushed >= 0, JSON.stringify(fj));

// ---- fast mode via the real PUT ----
const put = await call("PUT", "/api/settings/memory-freshness", adminCookie, { mode: "fast" });
check("PUT fast mode persists and changes tuning", put.status === 200 && getFreshness() === "fast" && tuning().idleMs === 15_000 && tuning().captureEvery === 1 && (await q("select value from settings where key='memory_freshness'"))[0].value === "fast");
await say({ channel: C.SALES, user: U.BOB, text: "Decision: the Borealis pilot with Hallmark Foods starts on 2026-12-01 and Bob owns it." });
const fastMs = await waitFact("%Borealis%", 40_000);
console.log(`fast mode ambient latency: ${fastMs}ms`);
check("fast mode: ambient message learned within ~15-25s (idle timer 15s + extraction)", fastMs >= 10_000 && fastMs <= 30_000, `${fastMs}ms`);
// thread capture after 1 turn
const t0 = Date.now();
const ts = await mention({ channel: C.ENG, user: U.PRIYA, text: "Remember that our new status page lives at status.acme.example and Dana owns it." });
const reply = slack.reply(C.ENG, ts);
const threadMs = await waitFact("%status page%", 30_000);
console.log(`fast mode turn->fact: reply after ${Date.now() - t0}ms; fact after ${threadMs}ms more`);
check("fast mode: a fact from a single turn exists right after the reply", threadMs >= 0 && threadMs < 15_000, `reply: ${reply.slice(0, 100)} | ${threadMs}ms`);
// back to normal: 3 turns before thread capture
await call("PUT", "/api/settings/memory-freshness", adminCookie, { mode: "normal" });
check("back to normal restores the cadence", getFreshness() === "normal" && tuning().captureEvery === 3);
setFreshnessMode("normal");

// ---- run-now: single-flight + rate limit with REAL runners ----
resetRunNow();
const bodies = Array.from({ length: 4 }, () => call("POST", "/api/memory/run", adminCookie, { job: "consolidate" }));
const rs = await Promise.all(bodies);
const codes = rs.map((r) => r.status).sort();
console.log("concurrent consolidate:", codes.join(","));
check("4 concurrent 'consolidate' runs: exactly one runs (200), the rest 409", codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 3, codes.join());
check("member cannot run jobs", (await call("POST", "/api/memory/run", memberCookie, { job: "consolidate" })).status === 403);
check("anonymous cannot", (await call("POST", "/api/memory/run", undefined, { job: "consolidate" })).status === 401);
check("unknown job -> 400", (await call("POST", "/api/memory/run", adminCookie, { job: "rm-rf" })).status === 400);
let last = 0; let retry: string | null = null;
for (let i = 0; i < 8; i++) { const r = await call("POST", "/api/memory/run", adminCookie, { job: "capture-flush" }); last = r.status; retry = r.headers.get("retry-after"); }
check("rate limit: > 6 starts/min -> 429 with Retry-After", last === 429 && !!retry, `${last} retry-after=${retry}`);
const sync = await call("POST", "/api/memory/run", adminCookie, { job: "sync" });
check("sync job with nothing configured succeeds quickly", sync.status === 200, JSON.stringify(await sync.json()));
finish("14 freshness + run-now");
