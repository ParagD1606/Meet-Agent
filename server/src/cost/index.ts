import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { settings, workspace } from "../db/schema";
import { log } from "../log";
import { slackClient } from "../slack/client";

type Row = Record<string, unknown>;
const usd = (micros: unknown) => Number(micros ?? 0) / 1e6;

/** Spend by day and model from the per-turn ledger (turns.cost_micros, set at turn end from the price table in llm.ts). */
export async function costReport(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = (await db.execute(sql`select to_char(started_at at time zone 'UTC','YYYY-MM-DD') as day, coalesce(model,'unknown') as model,
    count(*)::int as turns, coalesce(sum(cost_micros),0)::bigint as micros, coalesce(sum(input_tokens),0)::bigint as input, coalesce(sum(output_tokens),0)::bigint as output
    from turns where started_at >= ${since} group by 1, 2 order by 1, 2`)).rows as Row[];
  const byDay = new Map<string, { day: string; usd: number; turns: number; models: Record<string, number> }>();
  const byModel = new Map<string, { model: string; usd: number; turns: number; inputTokens: number; outputTokens: number }>();
  for (const r of rows) {
    const d = byDay.get(String(r.day)) ?? { day: String(r.day), usd: 0, turns: 0, models: {} };
    d.usd += usd(r.micros); d.turns += Number(r.turns); d.models[String(r.model)] = usd(r.micros);
    byDay.set(d.day, d);
    const m = byModel.get(String(r.model)) ?? { model: String(r.model), usd: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
    m.usd += usd(r.micros); m.turns += Number(r.turns); m.inputTokens += Number(r.input); m.outputTokens += Number(r.output);
    byModel.set(m.model, m);
  }
  return {
    days, totalUsd: [...byDay.values()].reduce((a, d) => a + d.usd, 0),
    byDay: [...byDay.values()], byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd),
    month: { spentUsd: await monthSpendUsd(), alertUsd: config.MONTHLY_SPEND_ALERT_USD ?? null },
  };
}

export async function monthSpendUsd(now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [r] = (await db.execute(sql`select coalesce(sum(cost_micros),0)::bigint as micros from turns where started_at >= ${start}`)).rows as Row[];
  return usd(r?.micros);
}

/**
 * One message per calendar month (UTC) to the workspace home channel once MONTHLY_SPEND_ALERT_USD is crossed. Alert only, no cap.
 * The settings row is the claim, so concurrent turns cannot double-post. Returns whether it posted.
 */
export async function checkSpendAlert(now = new Date(), limit = config.MONTHLY_SPEND_ALERT_USD): Promise<boolean> {
  if (!limit || limit <= 0) return false;
  const spent = await monthSpendUsd(now);
  if (spent < limit) return false;
  const key = `spend_alert_${now.toISOString().slice(0, 7)}`;
  const claimed = await db.insert(settings).values({ key, value: { spentUsd: spent, at: now.toISOString() } }).onConflictDoNothing().returning({ key: settings.key });
  if (!claimed.length) return false;
  const [ws] = await db.select({ home: workspace.homeChannelId }).from(workspace).limit(1);
  try {
    if (!ws?.home) throw new Error("no admin channel");
    await (await slackClient()).chat.postMessage({
      channel: ws.home,
      text: `:moneybag: Model spend this month is about $${spent.toFixed(2)}, past the $${limit} alert threshold (MONTHLY_SPEND_ALERT_USD). This is an alert only; nothing is paused.`,
    });
    return true;
  } catch (e) {
    await db.delete(settings).where(eq(settings.key, key)); // retry on the next turn
    log.warn("spend alert not posted", { error: String(e) });
    return false;
  }
}
