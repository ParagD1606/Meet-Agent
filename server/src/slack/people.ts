import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

export type Person = { id: string; name: string | null; title: string | null; email: string | null };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Name/email/title substring search over synced Slack users (humans, active only). */
export async function searchPeople(q: string, limit = 10): Promise<Person[]> {
  const term = q.trim();
  if (!term) return [];
  const pat = `%${escapeLike(term)}%`;
  return db.select({ id: users.id, name: users.name, title: users.title, email: users.email }).from(users)
    .where(and(eq(users.isBot, false), eq(users.deactivated, false),
      or(ilike(users.name, pat), ilike(users.email, pat), ilike(users.title, pat), eq(users.id, term.toUpperCase()))))
    .orderBy(users.name)
    .limit(Math.min(Math.max(limit, 1), 50));
}
