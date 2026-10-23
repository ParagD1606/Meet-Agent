import { and, eq, lt } from "drizzle-orm";
import { db } from "./db";
import { turns } from "./db/schema";
import { log, redactError } from "./log";

export { drain, inflightCount, ShuttingDownError } from "./turn/queue";

/**
 * Turns left `running` by a crashed/killed process can never finish. Called at boot (resumePending does it too).
 * A turn legitimately runs for at most a couple of minutes, so anything older than maxAgeMs is dead.
 */
export async function sweepStaleTurns(maxAgeMs = 10 * 60_000): Promise<number> {
  const rows = await db.update(turns)
    .set({ status: "error", error: "interrupted (server restarted)", finishedAt: new Date() })
    .where(and(eq(turns.status, "running"), lt(turns.startedAt, new Date(Date.now() - maxAgeMs))))
    .returning({ id: turns.id });
  if (rows.length) log.warn("swept stale running turns", { count: rows.length });
  return rows.length;
}

let installed = false;
/** Last-resort handlers so a stray rejection is logged instead of killing the process; fatal exceptions exit for the supervisor. */
export function installProcessHandlers(onFatal?: () => void): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { err: redactError(reason, 500) }));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { err: redactError(err, 500) });
    onFatal?.();
    setTimeout(() => process.exit(1), 1_000).unref();
  });
}
