import { app } from "./app";
import { ensureSetupToken } from "./auth";
import { config } from "./config";
import { lockPool, pool } from "./db";
import { runMigrations } from "./db/migrate";
import { startJobs, stopJobs } from "./jobs";
import { refreshModelSettings } from "./llm";
import { log } from "./log";
import { startSlack, stopSlack } from "./slack";
import { resumePending } from "./turn";

await runMigrations();
await refreshModelSettings();
setInterval(() => refreshModelSettings().catch((e) => log.warn("model settings refresh failed", { err: String(e) })), 30_000).unref();
await startJobs();
await resumePending();
await startSlack();
await ensureSetupToken(); // logs the owner-claim token while no owner exists

const server = Bun.serve({ port: config.PORT, fetch: app.fetch, idleTimeout: 60, maxRequestBodySize: 30 * 1024 * 1024 });
log.info("listening", { port: config.PORT, slackMode: config.SLACK_MODE });

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown", { sig });
  setTimeout(() => process.exit(1), 25_000).unref(); // drain deadline
  server.stop();
  await stopSlack().catch(() => {});
  await stopJobs().catch(() => {});
  await pool.end().catch(() => {});
  await lockPool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { err: String(e) }));
process.on("uncaughtException", (e) => log.error("uncaught exception", { err: String(e) }));
