import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { hasRole, requireAuth, type AppEnv } from "../auth/session";
import { db } from "../db";
import { channelMembers, channels, coreBlocks } from "../db/schema";

export const channelRoutes = new Hono<AppEnv>();

/** Channel picker source. Admins: every known non-DM channel. Members: only channels they are a member of. */
channelRoutes.get("/channels", requireAuth(), async (c) => {
  const me = c.get("user");
  const mine = hasRole(me.role, "admin")
    ? undefined
    : inArray(channels.id, db.select({ id: channelMembers.channelId }).from(channelMembers).where(eq(channelMembers.userId, me.id)));
  const rows = await db
    .select({
      id: channels.id, name: channels.name, isPrivate: channels.isPrivate, isIm: channels.isIm, botIsMember: channels.botIsMember,
      hasCoreBlock: sql<boolean>`exists (select 1 from ${coreBlocks} where ${coreBlocks.scopeTag} = 'channel_' || "channels"."id" and ${coreBlocks.text} <> '')`,
    })
    .from(channels)
    .where(and(eq(channels.isIm, false), mine))
    .orderBy(channels.name);
  return c.json(rows);
});
