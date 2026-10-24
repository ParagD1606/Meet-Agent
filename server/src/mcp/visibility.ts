import { inArray } from "drizzle-orm";
import { db } from "../db";
import { mcpConnections, users } from "../db/schema";
import { appLabel, groupKey } from "./group";
import { connWritable, getOrgWrites } from "./writes";

/**
 * One-line facts about connected apps for the model's context, from the database only (no live MCP call): which apps the
 * asker can use and in what mode, which exist only as someone else's personal connection, which need reconnecting.
 * Names only, never secrets or URLs. Lets the model say "GitHub is connected by Priya only" instead of "I don't have GitHub".
 */
export async function connectionNotes(ctx: { userId: string | null; orgConnectionsOnly: boolean; readOnly: boolean }): Promise<{ notes: string[]; othersOnly: boolean }> {
  const rows = await db.select().from(mcpConnections);
  if (!rows.length) return { notes: [], othersOnly: false };
  const orgWrites = await getOrgWrites().catch(() => true);
  const uid = ctx.orgConnectionsOnly ? null : ctx.userId;
  const mine = (c: (typeof rows)[number]) => c.scope === "org" || (!!uid && c.ownerUserId === uid);
  const usable: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const c of rows.filter(mine)) {
    const k = groupKey(c);
    if (c.status === "needs_reauth" || c.status === "error") { bad.push(`${appLabel(c)} (${c.scope === "org" ? "workspace" : "yours"}) needs reconnecting in Integrations`); continue; }
    if (c.status !== "connected" || seen.has(k)) continue;
    seen.add(k);
    const own = rows.some((x) => groupKey(x) === k && x.status === "connected" && x.scope === "user" && x.ownerUserId === uid);
    const write = !ctx.readOnly && (own || connWritable(c, orgWrites));
    usable.push(`${appLabel(c)} (${c.scope === "org" && !own ? "workspace" : "personal"}, ${write ? "read+write" : "read-only"}${c.scope === "org" && !own && !connWritable(c, orgWrites) ? ": an admin has not allowed writes" : ""})`);
  }
  const notes: string[] = [];
  let othersOnly = false;
  if (usable.length) notes.push(`you can use ${usable.join(", ")}`);
  if (usable.some((u) => u.endsWith("an admin has not allowed writes)")))
    notes.push("writes are disabled for workspace connections: if asked to create, edit or post in such an app, say exactly that (writes are disabled for workspace connections), that an admin can enable them in Integrations settings, or that the asker can connect their own account; never say the tools are \"not exposed\", missing or that you lack the app");
  if (uid) {
    const others = rows.filter((c) => c.scope === "user" && c.ownerUserId !== uid && c.status === "connected" && !seen.has(groupKey(c)));
    const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(others.map((c) => c.ownerUserId!))]))).map((u) => [u.id, u.name ?? u.id]));
    const byApp = new Map<string, Set<string>>();
    for (const c of others) (byApp.get(appLabel(c)) ?? byApp.set(appLabel(c), new Set()).get(appLabel(c))!).add(names.get(c.ownerUserId!) ?? "a teammate");
    othersOnly = byApp.size > 0;
    if (byApp.size)
      notes.push(`personal connections of others, usable only for their owner: ${[...byApp].map(([a, o]) => `${a} (by ${[...o].join(", ")})`).join(", ")}. If asked about one, say it is connected personally by that person, offer request_teammate_access, or say an admin can make it workspace-wide; never say you lack the app`);
  }
  if (bad.length) notes.push(bad.join("; "));
  return { notes, othersOnly };
}
