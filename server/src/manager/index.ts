import type PgBoss from "pg-boss";
import { log } from "../log";
import { chaseTick, workingHours } from "./chase";
import { runExtraction } from "./commitments";
import { digestTick, followUpTick } from "./followups";
import { riskTick } from "./risks";
import { standupTick } from "./standup";

export * from "./chase";
export * from "./commitments";
export * from "./risks";
export * from "./followups";
export * from "./tasks";
export * from "./capture";
export * from "./find";
export * from "./task-sync";
export * from "./standup";

export const MANAGER_Q = { extract: "manager-extract", chase: "manager-chase", daily: "manager-standup-daily", weekly: "manager-standup-weekly", risks: "manager-risks", followups: "manager-followups" } as const;

/** Extraction + chase run hourly; standups and the risk scan run at working-hours times in the workspace timezone. */
export async function registerManagerJobs(b: PgBoss): Promise<void> {
  for (const q of Object.values(MANAGER_Q)) await b.createQueue(q, { name: q, retryLimit: 0, policy: "short" });
  const { tz } = await workingHours();
  const opts = { tz };
  await b.work(MANAGER_Q.extract, async () => { log.info("commitment extraction", await runExtraction()); });
  await b.work(MANAGER_Q.chase, async () => { log.info("commitment chase", { nudged: await chaseTick() }); });
  await b.work(MANAGER_Q.daily, async () => { log.info("daily standup", { channels: await standupTick("daily") }); });
  await b.work(MANAGER_Q.weekly, async () => { log.info("weekly status", { channels: await standupTick("weekly") }); });
  await b.work(MANAGER_Q.risks, async () => { log.info("risk scan", await riskTick()); });
  await b.work(MANAGER_Q.followups, async () => { const sent = await followUpTick(); const d = await digestTick(); if (sent || d.digests || d.weekly) log.info("follow-ups", { sent, ...d }); });
  await b.schedule(MANAGER_Q.followups, "* * * * *");
  await b.schedule(MANAGER_Q.extract, "11 * * * *", undefined, opts);
  await b.schedule(MANAGER_Q.chase, "41 * * * *", undefined, opts);
  await b.schedule(MANAGER_Q.daily, "5 9 * * 1-5", undefined, opts);
  await b.schedule(MANAGER_Q.weekly, "0 16 * * 5", undefined, opts);
  await b.schedule(MANAGER_Q.risks, "30 9 * * 1-5", undefined, opts);
}
