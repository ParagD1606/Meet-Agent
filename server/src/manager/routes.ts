import { Hono } from "hono";
import { requireAuth, type AppEnv } from "../auth/session";
import { readTags } from "../memory/scope";
import { listCommitments, type Commitment } from "./commitments";

export const managerRoutes = new Hono<AppEnv>();

const STATUSES: Commitment["status"][] = ["open", "done", "dropped", "overdue"];

/** Commitments the requester may see: scope tags come from their own read surface (shared + their private channels + their DM tag), never wider. */
managerRoutes.get("/manager/commitments", requireAuth("admin"), async (c) => {
  const me = c.get("user");
  const tags = await readTags({ channelId: "", isPrivate: false, isIm: true, userId: me.id });
  const status = (c.req.query("status") ?? "").split(",").filter((s): s is Commitment["status"] => STATUSES.includes(s as never));
  const rows = await listCommitments({ tags, status, ownerId: c.req.query("owner") || undefined, limit: Number(c.req.query("limit")) || 100 });
  return c.json({ commitments: rows });
});
