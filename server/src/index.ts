import { app } from "./app";
import { config } from "./config";
import { pool } from "./db";
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

const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
log.info("listening", { port: config.PORT, slackMode: config.SLACK_MODE });

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown", { sig });
  server.stop();
  await stopSlack().catch(() => {});
  await stopJobs().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
