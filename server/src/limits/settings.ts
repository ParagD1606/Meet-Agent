import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { settings } from "../db/schema";

/** Admin-editable cost controls (settings key `limits`). 0 = unlimited for the numeric caps. */
export const limitsSchema = z.object({
  perTurnTokenCeiling: z.number().int().min(0).max(5_000_000),
  perUserDailyTokens: z.number().int().min(0).max(1_000_000_000),
  orgDailyTokens: z.number().int().min(0).max(10_000_000_000),
  maxStepsByDepth: z.object({
    direct: z.number().int().min(1).max(60),
    memory: z.number().int().min(1).max(60),
    tools: z.number().int().min(1).max(60),
    deep: z.number().int().min(1).max(60),
  }),
  concurrentTurns: z.number().int().min(1).max(100),
});
export type Limits = z.infer<typeof limitsSchema>;

export const DEFAULT_LIMITS: Limits = {
  perTurnTokenCeiling: 400_000,
  perUserDailyTokens: 2_000_000,
  orgDailyTokens: 20_000_000,
  maxStepsByDepth: { direct: 2, memory: 5, tools: 12, deep: 30 },
  concurrentTurns: 8,
};

const TTL_MS = 10_000;
let cached: { at: number; v: Limits } | null = null;
export const invalidateLimits = () => { cached = null; };

/** Stored value merged over the defaults (so a partial or old row never yields undefined). */
export function mergeLimits(raw: unknown): Limits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Limits>;
  const merged = { ...DEFAULT_LIMITS, ...r, maxStepsByDepth: { ...DEFAULT_LIMITS.maxStepsByDepth, ...(r.maxStepsByDepth ?? {}) } };
  const p = limitsSchema.safeParse(merged);
  return p.success ? p.data : DEFAULT_LIMITS;
}

export async function getLimits(): Promise<Limits> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.v;
  const [row] = await db.select().from(settings).where(eq(settings.key, "limits"));
  const v = mergeLimits(row?.value);
  cached = { at: Date.now(), v };
  return v;
}

export async function setLimits(next: Limits): Promise<Limits> {
  const v = limitsSchema.parse(next);
  await db.insert(settings).values({ key: "limits", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  cached = { at: Date.now(), v };
  return v;
}

export type Depth = "direct" | "memory" | "tools" | "deep";
export async function maxStepsFor(depth: Depth): Promise<number> {
  return (await getLimits()).maxStepsByDepth[depth];
}
