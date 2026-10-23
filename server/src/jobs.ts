import PgBoss from "pg-boss";
import { config } from "./config";
import { executeAutomation, findDue } from "./automations";
import { log } from "./log";
import { failStaleResearch, runResearch } from "./research";
import { seedBuiltinSkills } from "./skills/skills";

export const Q = {
  automationTick: "automation-tick",
  automationRun: "automation-run",
  researchRun: "research-run",
  journeyTick: "journey-tick",
} as const;

let boss: PgBoss | null = null;
let started = false;

/** Shared pg-boss instance (schema `pgboss`, same database). Not started until `startJobs()`. */
export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss" });
    boss.on("error", (err) => log.error("pg-boss error", { err: String(err) }));
  }
  return boss;
}

function ready(): PgBoss {
  if (!started) throw new Error("jobs not started");
  return getBoss();
}

export async function enqueueAutomation(id: string, fireAt: Date): Promise<void> {
  await ready().sendAfter(Q.automationRun, { id, fireAt: fireAt.toISOString() }, { singletonKey: `${id}:${fireAt.getTime()}` }, fireAt);
}

export async function enqueueResearch(id: string): Promise<void> {
  await ready().send(Q.researchRun, { id }, { retryLimit: 0 });
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
  for (const name of Object.values(Q)) await b.createQueue(name, { name, retryLimit: 0, policy: "short" });

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
