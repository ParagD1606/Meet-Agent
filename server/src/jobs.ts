import PgBoss from "pg-boss";
import { config } from "./config";
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
    } catch {
      // module absent or failed to load: try next / degrade
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
  await b.work(Q.purge, async () => { await purgeOld(); });
  await b.schedule(Q.purge, "17 3 * * *");
  await b.work(Q.membersResync, async () => {
    const { resyncChannelMembers } = await import("./slack/sync");
    log.info("members resync", await resyncChannelMembers().catch((e) => ({ error: String(e) })));
  });
  await b.schedule(Q.membersResync, "7 */6 * * *");

  await registerProactiveJobs(b);

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
  const stale = await failStaleResearch().catch(() => 0);
  if (stale) log.warn("failed stale research runs", { count: stale });
  log.info("jobs started");
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  started = false;
  await b.stop({ graceful: true, timeout: 10_000, close: true }).catch((err) => log.error("pg-boss stop failed", { err: String(err) }));
}
