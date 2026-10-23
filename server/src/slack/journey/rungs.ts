import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { automations, mcpConnections, turns } from "../../db/schema";

// Ladder order: a user is always offered the lowest rung they have not reached.
export const JOURNEY_RUNGS = ["connect_tool", "first_ask", "automation"] as const;
export type JourneyRung = (typeof JOURNEY_RUNGS)[number];
export type RungState = Record<JourneyRung, boolean>;

/** Read live at send time (never cached): a disconnected tool revokes its rung immediately. */
export async function readRungState(userId: string): Promise<RungState> {
  const [conn, ask, auto] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(mcpConnections)
      .where(and(eq(mcpConnections.ownerUserId, userId), eq(mcpConnections.status, "connected"))),
    db.select({ n: sql<number>`count(*)::int` }).from(turns)
      .where(and(eq(turns.userId, userId), inArray(turns.trigger, ["mention", "dm"]))),
    db.select({ n: sql<number>`count(*)::int` }).from(automations).where(eq(automations.ownerUserId, userId)),
  ]);
  return { connect_tool: (conn[0]?.n ?? 0) > 0, first_ask: (ask[0]?.n ?? 0) > 0, automation: (auto[0]?.n ?? 0) > 0 };
}
