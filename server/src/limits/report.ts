import { sql } from "drizzle-orm";
import { db } from "../db";

export const RANGES = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type Range = keyof typeof RANGES;

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

/** Aggregates `turns` for the Usage & limits page. Cost is the stored estimate (USD * 1e6). */
export async function usageReport(range: Range) {
  const since = new Date(Date.now() - RANGES[range] * 86_400_000);
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows as Row[];
  const agg = sql`count(*)::int as turns, coalesce(sum(input_tokens),0)::bigint as "inputTokens", coalesce(sum(output_tokens),0)::bigint as "outputTokens", coalesce(sum(cost_micros),0)::bigint as "costMicros"`;
  const [byDay, byUser, byModel, byRole, totals, breakdowns, topTurns] = await Promise.all([
    rows(sql`select to_char(started_at at time zone 'UTC','YYYY-MM-DD') as day, ${agg} from turns where started_at >= ${since} group by 1 order by 1`),
    rows(sql`select t.user_id as "userId", u.name as name, ${agg} from turns t left join users u on u.id = t.user_id where t.started_at >= ${since} group by t.user_id, u.name order by sum(t.input_tokens + t.output_tokens) desc nulls last limit 50`),
    rows(sql`select coalesce(model,'unknown') as model, ${agg} from turns where started_at >= ${since} group by 1 order by sum(input_tokens + output_tokens) desc nulls last`),
    // turns carry the trigger, not the model role: "role" here is the turn trigger (mention, dm, chime, automation, research)
    rows(sql`select trigger as role, ${agg} from turns where started_at >= ${since} group by 1 order by sum(input_tokens + output_tokens) desc nulls last`),
    rows(sql`select coalesce(sum(input_tokens),0)::bigint as i, coalesce(sum(cache_read_tokens),0)::bigint as c from turns where started_at >= ${since}`),
    rows(sql`select prompt_breakdown as b from turns where started_at >= ${since} and prompt_breakdown is not null order by started_at desc limit 2000`),
    rows(sql`select id, user_id as "userId", trigger, model, depth, steps, input_tokens as "inputTokens", output_tokens as "outputTokens", cost_micros as "costMicros", started_at as "startedAt" from turns where started_at >= ${since} order by (coalesce(input_tokens,0) + coalesce(output_tokens,0)) desc, started_at desc limit 10`),
  ]);
  const num = (r: Row) => ({ ...r, turns: n(r.turns), inputTokens: n(r.inputTokens), outputTokens: n(r.outputTokens), costMicros: n(r.costMicros) });

  const input = n(totals[0]?.i), cached = n(totals[0]?.c);
  // input tokens already include cached reads (AI SDK usage), so the rate is cached / input, clamped to 0..1
  const cacheHitRate = input > 0 ? Math.min(1, cached / input) : 0;

  const sums: Record<string, number> = {};
  for (const r of breakdowns) {
    const b = r.b as Record<string, number> | null;
    if (b) for (const [k, v] of Object.entries(b)) sums[k] = (sums[k] ?? 0) + (Number(v) || 0);
  }
  const avgBreakdown = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v / Math.max(1, breakdowns.length))]));

  return {
    range,
    byDay: byDay.map(num), byUser: byUser.map(num), byModel: byModel.map(num), byRole: byRole.map(num),
    cacheHitRate, avgBreakdown,
    topTurns: topTurns.map((t) => ({ ...t, inputTokens: n(t.inputTokens), outputTokens: n(t.outputTokens), costMicros: n(t.costMicros), steps: n(t.steps) })),
  };
}
