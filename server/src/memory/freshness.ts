import { eq } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { db } from "../db";
import { settings } from "../db/schema";
import { log } from "../log";

/** 'normal' = production cadence (cheap); 'fast' = demo cadence (learn within seconds, many more LLM calls). */
export type Freshness = "normal" | "fast";
export const FRESHNESS_KEY = "memory_freshness";

export type Tuning = {
  /** extract once a thread has this many turns */
  captureEvery: number;
  /** extract a thread this long after its last turn (timer + sweep) */
  idleMs: number;
  /** ambient channel buffer: flush after this many messages or idleMs of quiet */
  ambientMax: number;
  recallTtlMs: number;
  snapshotTtlMs: number;
  /** cron for the idle sweep and the channel observe poll */
  reflectCron: string;
  observeCron: string;
};

export const TUNING: Record<Freshness, Tuning> = {
  normal: { captureEvery: 3, idleMs: 5 * 60_000, ambientMax: 20, recallTtlMs: 60_000, snapshotTtlMs: 6 * 3600_000, reflectCron: "*/10 * * * *", observeCron: "*/30 * * * *" },
  fast: { captureEvery: 1, idleMs: 15_000, ambientMax: 20, recallTtlMs: 5_000, snapshotTtlMs: 5 * 60_000, reflectCron: "* * * * *", observeCron: "*/2 * * * *" },
};

const parse = (v: unknown): Freshness | null => (v === "fast" || v === "normal" ? v : null);
let mode: Freshness = parse(process.env.MEMORY_FRESHNESS) ?? "normal";
let boss: PgBoss | null = null;

export const getFreshness = (): Freshness => mode;
export const tuning = (): Tuning => TUNING[mode];
/** Test hook / PUT handler. Does not persist. */
export function setFreshnessMode(m: Freshness): void { mode = m; }

/** Reads the persisted setting (it wins over the env default). Call at boot. */
export async function loadFreshness(): Promise<Freshness> {
  const [r] = await db.select().from(settings).where(eq(settings.key, FRESHNESS_KEY));
  const m = parse(r?.value);
  if (m) mode = m;
  return mode;
}

export async function saveFreshness(m: Freshness): Promise<void> {
  await db.insert(settings).values({ key: FRESHNESS_KEY, value: m }).onConflictDoUpdate({ target: settings.key, set: { value: m } });
  mode = m;
  await applyMemorySchedules();
}

export const bindBoss = (b: PgBoss) => { boss = b; };

/** (Re)schedules the cron-driven memory jobs for the current mode; pg-boss replaces a schedule of the same name. */
export async function applyMemorySchedules(): Promise<void> {
  if (!boss) return;
  const t = tuning();
  try {
    await boss.schedule("memory-observe", t.observeCron);
    await boss.schedule("memory-reflect", t.reflectCron);
  } catch (e) { log.warn("memory reschedule failed", { err: String(e) }); }
}
