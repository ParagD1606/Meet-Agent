import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import type { Candidate } from "./items";

const cleanName = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const similarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = saved;
    }
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
};

export type Owner = { user: { id: string; name: string | null } | null; ambiguous: boolean; candidates: Candidate[] };

/**
 * A meeting item's owner as a real Slack user. By id when it is an active human; otherwise by name: an exact unique match, or a
 * fuzzy match only when it is clearly closer than anyone else. A close call is never picked: it comes back ambiguous with the top 3.
 */
export async function resolveOwner(a: { assigneeId?: string | null; assigneeName?: string | null }): Promise<Owner> {
  if (a.assigneeId) {
    const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, a.assigneeId), eq(users.deactivated, false), eq(users.isBot, false))).limit(1);
    if (user) return { user, ambiguous: false, candidates: [] };
  }
  if (!a.assigneeName?.trim()) return { user: null, ambiguous: false, candidates: [] };
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.deactivated, false), eq(users.isBot, false)));
  const needle = cleanName(a.assigneeName);
  const exact = people.filter((u) => cleanName(u.name ?? "") === needle);
  if (exact.length === 1) return { user: exact[0]!, ambiguous: false, candidates: [] };
  const first = (u: { name: string | null }) => cleanName((u.name ?? "").split(/\s+/)[0] ?? "");
  const byFirst = people.filter((u) => needle.length >= 3 && first(u) === needle);
  if (exact.length === 0 && byFirst.length === 1) return { user: byFirst[0]!, ambiguous: false, candidates: [] }; // "Dana" when only one Dana exists
  const ranked = people.map((u) => ({ user: u, score: Math.max(similarity(needle, cleanName(u.name ?? "")), needle.length >= 3 && first(u) === needle ? 0.8 : 0) }))
    .filter((r) => r.score >= 0.7).sort((x, y) => y.score - x.score);
  const candidates = ranked.slice(0, 3).map((r) => ({ id: r.user.id, name: r.user.name ?? r.user.id, score: Math.round(r.score * 100) / 100 }));
  // Never pick a close misspelling if another teammate is almost as likely.
  const top = ranked[0];
  if (top && top.score >= 0.9 && top.score - (ranked[1]?.score ?? 0) >= 0.08) return { user: top.user, ambiguous: false, candidates: [] };
  return { user: null, ambiguous: candidates.length > 0 || exact.length > 1, candidates };
}
