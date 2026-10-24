import PgBoss from "pg-boss";
import { config } from "./config";
import { quietHoursOn, workingHours } from "./manager/chase";
import { executeAutomation, findDue, registerProactiveJobs } from "./automations";
import { log } from "./log";
import { failStaleResearch, runResearch } from "./research";
import { seedBuiltinSkills } from "./skills/skills";

export const Q = {
  automationTick: "automation-tick",
  automationRun: "automation-run",
  researchRun: "research-run",
  journeyTick: "journey-tick",
  purge: "purge-old",
  membersResync: "members-resync",
  askDeliver: "ask-deliver",
  mcpHealth: "mcp-health",
  githubReconcile: "github-reconcile",
} as const;

let boss: PgBoss | null = null;
let started = false;

/** Shared pg-boss instance (schema `pgboss`, same database). Not started until `startJobs()`. */
export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss", max: 5 });
    boss.on("error", (err) => log.error("pg-boss error", { err: String(err) }));
  }
  return boss;
}

export const jobsStarted = (): boolean => started;

function ready(): PgBoss {
  if (!started) throw new Error("jobs not started");
  return getBoss();
}

export async function enqueueAutomation(id: string, fireAt: Date): Promise<void> {
  await ready().sendAfter(Q.automationRun, { id, fireAt: fireAt.toISOString() }, { singletonKey: `${id}:${fireAt.getTime()}` }, fireAt);
}

/** Re-attempt a quiet-hours-deferred ask_teammate delivery at the next working window. */
export async function enqueueAskDelivery(id: string, at: Date): Promise<void> {
  await workingHours(); // refresh quiet-hours flag; with quiet hours off nothing should wait for a future window
  if (!quietHoursOn() && at.getTime() > Date.now()) at = new Date();
  await ready().sendAfter(Q.askDeliver, { id }, { singletonKey: `${id}:${at.getTime()}` }, at);
}

/**
 * Boot sweep (also run when quiet hours are switched off): queued ask-deliver jobs whose ask is gone, no longer 'confirmed'
 * or older than 24h are cancelled; jobs whose delivery is now allowed are pulled forward to run immediately.
 */
export async function sweepAskDeliveries(now = new Date()): Promise<{ cancelled: number; released: number }> {
  const { pool } = await import("./db");
  const { getAsk, nextWindow, ASK_TTL_MS } = await import("./slack/teammate");
  await workingHours();
  const { rows } = await pool.query("select id, data->>'id' as ask from pgboss.job where name = $1 and state = 'created'", [Q.askDeliver]);
  const out = { cancelled: 0, released: 0 };
  for (const r of rows) {
    const ask = r.ask ? await getAsk(r.ask) : null;
    const stale = !ask || ask.status !== "confirmed" || !ask.createdAt || now.getTime() - Date.parse(ask.createdAt) > ASK_TTL_MS;
    if (stale) { await pool.query("update pgboss.job set state = 'cancelled', completed_on = now() where id = $1 and state = 'created'", [r.id]); out.cancelled++; }
    else if (nextWindow(now) === null) out.released += (await pool.query("update pgboss.job set start_after = now() where id = $1 and state = 'created' and start_after > now()", [r.id])).rowCount ?? 0;
  }
  return out;
}

/** Throws when pg-boss refuses the job (send() returns null for a deduped/throttled job): a silently dropped run would sit `planned` forever. */
export async function enqueueResearch(id: string): Promise<void> {
  const jobId = await ready().send(Q.researchRun, { id }, { retryLimit: 0, singletonKey: id, expireInSeconds: 30 * 60 });
  if (!jobId) throw new Error(`research job ${id} was not enqueued`);
}

/** Retention. Safe to run repeatedly. */
export async function purgeOld(now = new Date()): Promise<Record<string, number>> {
  const { pool } = await import("./db");
  const q = async (name: string, sql: string) => [name, (await pool.query(sql)).rowCount ?? 0] as const;
  const out = await Promise.all([
    q("sessions", "delete from sessions where expires_at < now()"),
    q("events", "delete from events where created_at < now() - interval '7 days'"),
    q("toolResults", "delete from tool_results where created_at < now() - interval '30 days'"),
    q("turns", "delete from turns where started_at < now() - interval '90 days' and status <> 'running'"),
    q("approvals", "delete from approvals where expires_at < now() - interval '30 days'"),
    q("leases", "delete from leases where expires_at < now() - interval '30 days'"),
    q("rateLimits", "delete from rate_limits where updated_at < now() - interval '2 days'"),
    q("chimeLog", "delete from chime_log where at < now() - interval '7 days'"),
    q("usageDaily", "delete from usage_daily where day < to_char(now() - interval '400 days', 'YYYY-MM-DD')"),
    q("recallLog", "delete from recall_log where created_at < now() - interval '30 days'"),
    // the (channel, ts) ledger is only needed while a message can still be re-delivered or re-polled
    q("ambientMessages", "delete from ambient_messages where flushed_at is not null and created_at < now() - interval '14 days'"),
    q("followUps", "delete from follow_ups where status in ('sent','cancelled','failed') and due_at < now() - interval '90 days'"),
    q("commitments", "delete from commitments where status in ('done','dropped') and coalesce(completed_at, created_at) < now() - interval '180 days'"),
    // always keep the newest run that can still be undone
    q("consolidationLog", `delete from consolidation_log where created_at < now() - interval '90 days'
      and run_id <> coalesce((select run_id from consolidation_log where undone_at is null order by created_at desc, id desc limit 1), '')`),
    q("managerRisks", "delete from manager_risks where posted_at < now() - interval '90 days'"),
    q("memoryReminders", "delete from memory_reminders where reminded_at < now() - interval '60 days'"),
    q("captureBuffer", "delete from capture_buffer where last_at < now() - interval '7 days' and attempts >= 3"),
  ]);
  const res = Object.fromEntries(out);
  log.info("purge", res);
  return res;
}

/** pg-boss liveness for /readyz-style checks. */
export async function bossHealthy(): Promise<boolean> {
  if (!started) return false;
  try { await Promise.race([getBoss().getQueueSize(Q.automationTick), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3_000))]); return true; }
  catch { return false; }
}

/** Enqueue every automation whose scheduled fire has passed (cron: every minute; also the one-off safety net). */
export async function automationTick(now = new Date()): Promise<number> {
  const due = await findDue(now);
  for (const d of due) await enqueueAutomation(d.id, d.fireAt);
  return due.length;
}

/** First export named `key` among the candidate modules; modules owned by other areas may not exist yet. */
async function optionalExport<T>(paths: string[], key: string): Promise<T | undefined> {
  for (const p of paths) {
    try {
      const fn = (await import(p))[key];
      if (typeof fn === "function") return fn as T;
    } catch (e) {
      // a module that is simply absent is fine (try the next candidate); one that exists but fails to load must not silently disable its jobs
      const absent = /Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e)) && String(e).includes(p);
      if (absent) continue;
      if (config.NODE_ENV !== "test") throw e;
      log.warn("optional job module failed to load", { path: p, err: String(e) });
    }
  }
  return undefined;
}

export async function startJobs(): Promise<void> {
  if (started) return;
  const b = getBoss();
  await b.start();
  started = true;

  // Runs are at-most-once: a retried digest could double-post.
  // "short" policy: one queued job per singletonKey, so tick + exact-time enqueues of the same fire collapse.
  for (const name of Object.values(Q)) {
    if (name === Q.researchRun) {
      // standard policy + per-run singletonKey: a second queued run must never silently displace or drop the first
      // an older deployment created this queue with the "short" policy (one queued job per queue); createQueue never changes
      // an existing queue, so recreate it when it is empty
      const existing = await b.getQueue(name).catch(() => null);
      if (existing && existing.policy !== "standard" && (await b.getQueueSize(name)) === 0) {
        await b.purgeQueue(name).catch(() => {});
        await b.deleteQueue(name).catch((e) => log.warn("could not recreate research queue", { err: String(e) }));
      }
      await b.createQueue(name, { name, retryLimit: 0, policy: "standard" });
    } else await b.createQueue(name, { name, retryLimit: 0, policy: "short" });
  }

  await b.work<{ id: string; fireAt?: string }>(Q.automationRun, async (jobs) => {
    for (const j of jobs) {
      const status = await executeAutomation(j.data.id, { fireAt: j.data.fireAt ? new Date(j.data.fireAt) : new Date() });
      log.info("automation run", { id: j.data.id, status });
    }
  });
  await b.work(Q.automationTick, async () => {
    await automationTick();
  });
  await b.work<{ id: string }>(Q.researchRun, async (jobs) => {
    for (const j of jobs) log.info("research run", { id: j.data.id, result: await runResearch(j.data.id) });
  });
  await b.schedule(Q.automationTick, "* * * * *");
  await b.work<{ id: string }>(Q.askDeliver, async (jobs) => {
    const { attemptDelivery } = await import("./slack/teammate");
    for (const j of jobs) log.info("ask delivery", { id: j.data.id, result: await attemptDelivery(j.data.id) });
  });
  await b.work(Q.purge, async () => { await purgeOld(); });
  await b.schedule(Q.purge, "17 3 * * *");
  await b.work(Q.membersResync, async () => {
    const { resyncChannelMembers } = await import("./slack/sync");
    // throw so pg-boss records the failure (retryLimit stays 0)
    log.info("members resync", await resyncChannelMembers().catch((e) => { log.warn("members resync failed", { err: String(e) }); throw e; }));
  });
  await b.schedule(Q.membersResync, "7 */6 * * *");
  await b.work(Q.mcpHealth, async () => {
    const { verifyAllConnections } = await import("./mcp/health");
    log.info("mcp health", await verifyAllConnections().catch((e) => { log.warn("mcp health failed", { err: String(e) }); throw e; }));
  });
  await b.schedule(Q.mcpHealth, "23 * * * *");
  await b.work(Q.githubReconcile, async () => {
    const { reconcileGithub } = await import("./integrations/github-reconcile");
    log.info("github reconcile", await reconcileGithub().catch((e) => { log.warn("github reconcile failed", { err: String(e).slice(0, 200) }); throw e; }));
  });
  await b.schedule(Q.githubReconcile, "41 * * * *");

  await registerProactiveJobs(b);
  await (await import("./manager")).registerManagerJobs(b);

  const journeyTick = await optionalExport<() => Promise<unknown>>(["./slack/journey", "./slack/onboarding"], "journeyTick");
  if (journeyTick) {
    await b.work(Q.journeyTick, async () => {
      await journeyTick();
    });
    await b.schedule(Q.journeyTick, "*/30 * * * *");
  } else {
    log.warn("journeyTick not available; journey nudges disabled");
  }
  const registerSyncJobs = await optionalExport<(boss: PgBoss) => Promise<void> | void>(["./platform2/sync", "./sync"], "registerSyncJobs");
  await registerSyncJobs?.(b);
  const registerMemoryJobs = await optionalExport<(boss: PgBoss) => Promise<void> | void>(["./memory/observe"], "registerMemoryJobs");
  if (registerMemoryJobs) await registerMemoryJobs(b);
  else log.warn("registerMemoryJobs not available; observe/consolidate disabled");

  await seedBuiltinSkills().catch((err) => log.error("skill seed failed", { err: String(err) }));
  const stale = await failStaleResearch().catch((e) => { log.warn("failStaleResearch failed", { err: String(e) }); return 0; });
  if (stale) log.warn("failed stale research runs", { count: stale });
  await sweepAskDeliveries().then((r) => { if (r.cancelled || r.released) log.info("ask-deliver sweep", r); }).catch((e) => log.warn("ask-deliver sweep failed", { err: String(e) }));
  log.info("jobs started");
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  started = false;
  await b.stop({ graceful: true, timeout: 10_000, close: true }).catch((err) => log.error("pg-boss stop failed", { err: String(err) }));
}
