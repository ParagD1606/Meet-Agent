import { ghx } from "./github-api";
import { githubCredential } from "./github-auth";
import { activeUsers, assignable } from "./github-repos";

export type Person = { id: string; name: string | null; email: string | null };
export type Candidate = { login: string; name?: string | null; email?: string | null };
export type Suggestion = { userId: string; userName: string | null; login: string; confidence: "high" | "medium" | "low"; reason: string };

/** lowercase, accents and punctuation dropped, single spaces */
export const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Pure matcher. In order: exact email (high), login == email local part (medium), identical normalised full name (low).
 * A person and a login are each used once, and an ambiguous key (two people or two logins sharing it) is never guessed.
 */
export function matchOwners(people: Person[], cands: Candidate[]): Suggestion[] {
  const out: Suggestion[] = [];
  const takenU = new Set<string>(), takenL = new Set<string>();
  const pass = (confidence: Suggestion["confidence"], reason: string, pk: (p: Person) => string, ck: (c: Candidate) => string) => {
    const pm = new Map<string, Person[]>(), cm = new Map<string, Candidate[]>();
    for (const p of people) if (!takenU.has(p.id) && pk(p)) pm.set(pk(p), [...(pm.get(pk(p)) ?? []), p]);
    for (const c of cands) if (!takenL.has(c.login) && ck(c)) cm.set(ck(c), [...(cm.get(ck(c)) ?? []), c]);
    for (const [k, ps] of pm) {
      const cs = cm.get(k);
      if (ps.length !== 1 || cs?.length !== 1) continue;
      out.push({ userId: ps[0]!.id, userName: ps[0]!.name, login: cs[0]!.login, confidence, reason });
      takenU.add(ps[0]!.id); takenL.add(cs[0]!.login);
    }
  };
  pass("high", "same email", (p) => p.email?.trim().toLowerCase() ?? "", (c) => c.email?.trim().toLowerCase() ?? "");
  pass("medium", "GitHub login matches the email name", (p) => p.email?.split("@")[0]?.toLowerCase() ?? "", (c) => c.login.toLowerCase());
  pass("low", "same full name", (p) => (norm(p.name).includes(" ") ? norm(p.name) : ""), (c) => (norm(c.name).includes(" ") ? norm(c.name) : ""));
  return out;
}

/** Profiles (public name / email) for up to 100 logins, 8 at a time; a failed profile just has no name. */
async function profiles(token: string, logins: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < logins.length) {
      const login = logins[i++]!;
      const r = await ghx(token, "GET", `/users/${encodeURIComponent(login)}`).catch(() => null);
      out.push({ login, name: r?.status === 200 ? r.data?.name : null, email: r?.status === 200 ? r.data?.email : null });
    }
  }));
  return out;
}

/** Candidates (assignable logins with their public profiles) and suggested people mapping for `repo`. */
export async function suggestMapping(repo: string, pat?: string): Promise<{ candidates: Candidate[]; suggestions: Suggestion[] }> {
  const logins = (await assignable(repo, pat)).map((u) => u.login).slice(0, 100);
  const cred = pat ? { token: pat } : await githubCredential(repo);
  const candidates: Candidate[] = cred ? await profiles(cred.token, logins) : logins.map((login) => ({ login }));
  candidates.sort((a, b) => a.login.localeCompare(b.login));
  return { candidates: candidates.map(({ login, name }) => ({ login, name })), suggestions: matchOwners(await activeUsers(), candidates) };
}
