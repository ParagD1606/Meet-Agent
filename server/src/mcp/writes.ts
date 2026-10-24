import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import type { ConnectionRow } from "./client";

const KEY = "mcp_org_writes";

/** Workspace setting: may members trigger WRITE tools through workspace (org) connections? Default ON. */
export async function getOrgWrites(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return (row?.value as { enabled?: boolean } | undefined)?.enabled !== false;
}
export async function setOrgWrites(enabled: boolean): Promise<boolean> {
  const value = { enabled };
  await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return enabled;
}

/** Personal connections always write as their owner; a workspace connection follows its own override, else the workspace setting. */
export const connWritable = (c: Pick<ConnectionRow, "scope" | "allowWrites">, orgWrites: boolean): boolean =>
  c.scope === "user" || (c.allowWrites ?? orgWrites);
