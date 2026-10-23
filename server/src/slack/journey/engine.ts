import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { journeyState, users } from "../../db/schema";
import { log } from "../../log";
import { nudgeCard } from "../cards";
import { postDm } from "../client";
import { decideNudge, type Decision, type JourneyData } from "./guardrails";
import { JOURNEY_RUNGS, readRungState } from "./rungs";

/** Creates the user's journey row. Returns true only for the call that created it (so welcome fires once). */
export async function startJourney(userId: string, now = new Date()): Promise<boolean> {
  const rows = await db.insert(journeyState)
    .values({ userId, rung: 0, data: { welcomedAt: now.toISOString(), lastNudgeAt: now.toISOString() } satisfies JourneyData })
    .onConflictDoNothing().returning({ userId: journeyState.userId });
  return rows.length > 0;
}

async function load(userId: string): Promise<JourneyData | null> {
  const [row] = await db.select().from(journeyState).where(eq(journeyState.userId, userId));
  return row ? (row.data as JourneyData) : null;
}

async function save(userId: string, patch: Partial<JourneyData>, rung?: number) {
  await db.update(journeyState)
    .set({ data: sql`${journeyState.data} || ${JSON.stringify(patch)}::jsonb`, ...(rung !== undefined ? { rung } : {}), updatedAt: new Date() })
    .where(eq(journeyState.userId, userId));
}

/** User opted out ("Not now / stop tips"): never nudge again. */
export async function setJourneyQuiet(userId: string, quiet = true) {
  await db.insert(journeyState).values({ userId, rung: 0, data: { quiet } }).onConflictDoNothing();
  await save(userId, { quiet });
}

/** One user's turn on the ladder. Exported for tests; `send` is injectable. */
export async function nudgeUser(
  userId: string,
  now = Date.now(),
  send: (userId: string, rung: (typeof JOURNEY_RUNGS)[number]) => Promise<boolean> = defaultSend,
): Promise<Decision | { action: "none" }> {
  const data = await load(userId);
  if (!data) return { action: "none" };
  const state = await readRungState(userId);
  const decision = decideNudge(data, state, now);
  const granted = JOURNEY_RUNGS.filter((r) => state[r]).length;
  if (decision.action === "exit") {
    await save(userId, { exited: decision.reason }, granted);
  } else if (decision.action === "send") {
    const ok = await send(userId, decision.rung);
    if (ok) {
      const n = (data.nudges?.[decision.rung] ?? 0) + 1;
      await save(userId, { lastNudgeAt: new Date(now).toISOString(), nudges: { ...data.nudges, [decision.rung]: n } }, granted);
    }
  } else await save(userId, {}, granted);
  return decision;
}

async function defaultSend(userId: string, rung: (typeof JOURNEY_RUNGS)[number]): Promise<boolean> {
  const card = nudgeCard(rung);
  return (await postDm(userId, card.text, card.blocks)) !== null;
}

/** Called by the jobs cron (e.g. hourly). Per-user failures never stop the sweep. */
export async function journeyTick(now = Date.now()): Promise<{ checked: number; sent: number }> {
  const rows = await db.select({ userId: journeyState.userId }).from(journeyState)
    .innerJoin(users, eq(users.id, journeyState.userId))
    .where(and(eq(users.isBot, false), eq(users.deactivated, false), sql`${journeyState.data}->>'exited' is null`, sql`coalesce((${journeyState.data}->>'quiet')::boolean, false) = false`))
    .limit(500);
  let sent = 0;
  for (const { userId } of rows) {
    try {
      const d = await nudgeUser(userId, now);
      if (d.action === "send") sent++;
    } catch (err) { log.warn("journey nudge failed", { userId, error: (err as Error).message }); }
  }
  return { checked: rows.length, sent };
}
