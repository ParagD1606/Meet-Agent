import { runAllSyncs } from "../sync";
import { db } from "../db";
import { syncSources } from "../db/schema";
import { syncRecentHuddles } from "../meetings";
import { flushIdleAmbient } from "./ambient";
import { backfillAll } from "./backfill";
import { consolidate } from "./consolidate";
import { backfillContextPrefixes } from "./context-prefix";
import { observeAll } from "./observe";
import { flushIdleCaptures } from "./writeback";

export const RUN_JOBS = ["observe", "consolidate", "capture-flush", "sync", "backfill-prefix", "backfill-history"] as const;
export type RunJob = (typeof RUN_JOBS)[number];

/** Reuses the scheduled job bodies; each returns plain counts. */
export const runners: Record<RunJob, () => Promise<Record<string, unknown>>> = {
  observe: async () => ({ ...(await observeAll()), ambientFacts: await flushIdleAmbient(0) }),
  consolidate: async () => ({ ...(await consolidate()) }),
  "capture-flush": async () => ({ facts: await flushIdleCaptures(0), ambientFacts: await flushIdleAmbient(0) }),
  sync: async () => {
    const huddles = await syncRecentHuddles().catch((e) => ({ error: String(e) }));
    await runAllSyncs();
    return { huddles, sources: (await db.select({ id: syncSources.id }).from(syncSources)).length };
  },
  "backfill-prefix": async () => ({ prefixed: await backfillContextPrefixes() }),
  "backfill-history": async () => ({ ...(await backfillAll({ calls: 40 })) }),
};

export const RATE_MAX = 6; // starts per job per RATE_WINDOW_MS
export const RATE_WINDOW_MS = 60_000;
const running = new Set<RunJob>();
const starts = new Map<RunJob, number[]>();
export const resetRunNow = () => { running.clear(); starts.clear(); };

export type RunOutcome =
  | { ok: true; job: RunJob; ms: number; counts: Record<string, unknown> }
  | { ok: false; error: "already_running" | "rate_limited" | "failed"; job: RunJob; retryAfterSec?: number; message?: string };

/** Single-flight per job (a second call while one runs is refused) plus a small per-job rate limit. In-process; ponytail: advisory lock if more than one replica. */
export async function runNow(job: RunJob, now = () => Date.now(), run = runners): Promise<RunOutcome> {
  if (running.has(job)) return { ok: false, error: "already_running", job };
  const t = now();
  const recent = (starts.get(job) ?? []).filter((s) => t - s < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) return { ok: false, error: "rate_limited", job, retryAfterSec: Math.ceil((RATE_WINDOW_MS - (t - recent[0]!)) / 1000) };
  starts.set(job, [...recent, t]);
  running.add(job);
  try {
    return { ok: true, job, counts: await run[job](), ms: now() - t };
  } catch (e) {
    return { ok: false, error: "failed", job, message: String(e).slice(0, 300) };
  } finally {
    running.delete(job);
  }
}
