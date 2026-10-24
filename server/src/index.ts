import { app } from "./app";
import { ensureSetupToken } from "./auth";
import { config, serverOptions } from "./config";
import { lockPool, pool } from "./db";
import { runMigrations } from "./db/migrate";
import { startJobs, stopJobs } from "./jobs";
import { bootBackfillTasks } from "./manager/task-sync";
import { refreshModelSettings } from "./llm";
import { drain, installProcessHandlers } from "./lifecycle";
import { log } from "./log";
import { startSlack, stopSlack } from "./slack";
import { resumePending } from "./turn";

installProcessHandlers();
await runMigrations();
await refreshModelSettings();
setInterval(() => refreshModelSettings().catch((e) => log.warn("model settings refresh failed", { err: String(e) })), 30_000).unref();
await startJobs();
await resumePending();
await startSlack();
void bootBackfillTasks(); // one-time: assignment facts + meeting tasks -> Tasks tab
await ensureSetupToken(); // logs the owner-claim token while no owner exists

const server = Bun.serve({ port: config.PORT, fetch: app.fetch, ...serverOptions });
log.info("listening", { port: config.PORT, slackMode: config.SLACK_MODE });

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown", { sig });
  setTimeout(() => process.exit(1), 25_000).unref(); // drain deadline
  server.stop();
  await drain(20_000).catch(() => {}); // let in-flight turns finish before tearing down dependencies
  await stopSlack().catch(() => {});
  await stopJobs().catch(() => {});
  await pool.end().catch(() => {});
  await lockPool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
