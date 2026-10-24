import { and, desc, eq } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { commitments, integrationPushes, users } from "../db/schema";
import { canRead } from "../manager/commitments";
import { createIssue, getGithub } from "../integrations/github-issues";
import { createCard, getTrello } from "../integrations/trello";
import { IntegrationError, type Created, type PushPayload } from "../integrations/types";
import { meetingItems, setItemExternalRef, type Actor, type ExternalRef } from "./meeting-source";

export type Target = "trello" | "github";
const PROVIDER: Record<Target, string> = { trello: "trello", github: "github" };
export type PushResult = { ref: string; title: string; status: "created" | "existing" | "skipped" | "failed"; url?: string; reason?: string; warning?: string };
type User = { id: string; role: Actor["role"] };
const isAdmin = (u: User) => u.role === "admin" || u.role === "owner";

/** One push at a time per (target, task) in this process, so a double click cannot create two cards. ponytail: single instance; add a DB advisory lock if the API ever scales out. */
const inflight = new Map<string, Promise<PushResult>>();

const existing = async (target: Target, refs: string[]): Promise<{ url: string } | null> => {
  for (const r of refs) {
    const [row] = await db.select().from(integrationPushes).where(and(eq(integrationPushes.target, target), eq(integrationPushes.taskRef, r), eq(integrationPushes.status, "ok"))).orderBy(desc(integrationPushes.at)).limit(1);
    if (row) return { url: row.externalUrl ?? "" };
  }
  return null;
};

async function create(target: Target, p: PushPayload): Promise<Created> {
  if (target === "trello") { const s = await getTrello(); if (!s) throw new IntegrationError("not_configured", "Trello is not configured"); return createCard(p, s); }
  const s = await getGithub();
  if (!s) throw new IntegrationError("not_configured", "GitHub Issues is not configured");
  return createIssue(p, s);
}

type Job = { taskRef: string; aliases?: string[]; title: string; payload: PushPayload; user: User; onSaved: (ref: ExternalRef) => Promise<void> };

/** Idempotent push + audit row. Never throws: every failure becomes a `failed` result. */
function run(target: Target, job: Job): Promise<PushResult> {
  const key = `${target}|${job.taskRef}`;
  const busy = inflight.get(key);
  if (busy) return busy;
  const p = (async (): Promise<PushResult> => {
    const base = { ref: job.taskRef, title: job.title };
    const have = await existing(target, [job.taskRef, ...(job.aliases ?? [])]);
    if (have) return { ...base, status: "existing", url: have.url };
    try {
      const made = await create(target, job.payload);
      await db.insert(integrationPushes).values({ id: newId("ip_"), userId: job.user.id, target, taskRef: job.taskRef, externalId: made.id, externalUrl: made.url, status: "ok", error: made.warning ?? null, ...(target === "github" ? { lastState: "open" as const } : {}) });
      await job.onSaved({ provider: PROVIDER[target], id: made.id, url: made.url }).catch(() => {}); // the audit row already guards against duplicates
      return { ...base, status: "created", url: made.url, ...(made.warning ? { warning: made.warning } : {}) };
    } catch (e) {
      const msg = e instanceof IntegrationError ? e.message : "Unexpected error while pushing";
      await db.insert(integrationPushes).values({ id: newId("ip_"), userId: job.user.id, target, taskRef: job.taskRef, status: "failed", error: msg });
      return { ...base, status: "failed", reason: msg };
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Runs jobs in order; once the board answers "rate limited" the rest are skipped with that reason instead of hammering it. */
async function runAll(target: Target, jobs: (Job | PushResult)[]): Promise<PushResult[]> {
  const out: PushResult[] = [];
  let limited = "";
  for (const j of jobs) {
    if ("status" in j) { out.push(j); continue; }
    if (limited) { out.push({ ref: j.taskRef, title: j.title, status: "skipped", reason: limited }); continue; }
    const r = await run(target, j);
    if (r.status === "failed" && /rate limit/i.test(r.reason ?? "")) limited = `${r.reason}; not attempted`;
    out.push(r);
  }
  return out;
}

// ---------- commitments ----------
type Loaded = typeof commitments.$inferSelect;

async function commitmentJob(row: Loaded, user: User): Promise<Job | PushResult> {
  const base = { ref: `commitment:${row.id}`, title: row.text };
  // unreadable and missing look the same: ids cannot be probed
  if (!(await canRead(row, user.id))) return { ...base, ref: `commitment:${row.id}`, title: "(unavailable)", status: "skipped", reason: "not_found" };
  if (!(isAdmin(user) || row.ownerId === user.id || row.assignerId === user.id)) return { ...base, status: "skipped", reason: "Only an admin, the owner or the assigner can send this task" };
  if (row.status === "dropped" || row.status === "done") return { ...base, status: "skipped", reason: `Task is ${row.status}` };
  const [o] = row.ownerId ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId)) : [];
  return {
    taskRef: base.ref, title: row.text, user,
    payload: { title: row.text, description: row.priority === "urgent" ? "Priority: urgent" : "", sourceUrl: row.permalink ?? "", quote: "", due: row.dueAt, ownerId: row.ownerId, ownerName: o?.name ?? row.ownerName, origin: row.sourceType === "meeting" ? "a meeting" : "Slack", taskId: row.id, urgent: row.priority === "urgent" },
    onSaved: async (ref) => { await db.update(commitments).set({ externalRefs: [...row.externalRefs.filter((r) => r.provider !== ref.provider), ref] }).where(eq(commitments.id, row.id)); },
  };
}

export async function pushCommitments(ids: string[], target: Target, user: User): Promise<PushResult[]> {
  const jobs: (Job | PushResult)[] = [];
  for (const id of [...new Set(ids)]) {
    const [row] = await db.select().from(commitments).where(eq(commitments.id, id));
    jobs.push(row ? await commitmentJob(row, user) : { ref: `commitment:${id}`, title: "(unavailable)", status: "skipped", reason: "not_found" });
  }
  return runAll(target, jobs);
}

// ---------- meeting items ----------
/** itemIds | "approved" (every approved task). Null = meeting missing / unreadable. */
export async function pushMeetingItems(meetingId: string, target: Target, user: User, which: string[] | "approved"): Promise<PushResult[] | null> {
  const m = await meetingItems(meetingId, { userId: user.id, role: user.role });
  if (!m) return null;
  const wanted = which === "approved" ? null : new Set(which);
  const jobs: (Job | PushResult)[] = [];
  const seen = new Set<string>();
  m.rows.forEach((r, i) => {
    const itemId = r.itemId ?? String(i);
    if (wanted ? !wanted.has(itemId) : !(r.itemType === "task" && r.approval === "approved")) return;
    seen.add(itemId);
    const ref = `meeting:${meetingId}:${itemId}`;
    if (r.itemType !== "task") return void jobs.push({ ref, title: r.title, status: "skipped", reason: `A ${r.itemType} is not a task` });
    if (r.approval !== "approved") return void jobs.push({ ref, title: r.title, status: "skipped", reason: `Not approved yet (${r.approval})` });
    if (!(isAdmin(user) || m.meeting.ownerId === user.id || r.assigneeId === user.id)) return void jobs.push({ ref, title: r.title, status: "skipped", reason: "Only an admin, the organizer or the assignee can send this item" });
    jobs.push({
      taskRef: ref, title: r.title, user,
      payload: { title: r.title, description: r.description ?? "", sourceUrl: m.meeting.url, quote: r.quote, due: r.due && !Number.isNaN(Date.parse(r.due)) ? new Date(r.due) : null, ownerId: r.assigneeId ?? null, ownerName: r.assignee, origin: `meeting "${m.meeting.title}"`, taskId: ref, urgent: r.priority === "urgent" },
      onSaved: async (x) => { await setItemExternalRef(meetingId, itemId, x); },
    });
  });
  for (const id of wanted ?? []) if (!seen.has(id)) jobs.push({ ref: `meeting:${meetingId}:${id}`, title: "(unavailable)", status: "skipped", reason: "not_found" });
  // an approved item that already became a commitment (source_ref = the same key) shares its push record
  for (const j of jobs) if (!("status" in j)) {
    const [c] = await db.select({ id: commitments.id, refs: commitments.externalRefs }).from(commitments).where(eq(commitments.sourceRef, j.taskRef));
    if (c) { j.aliases = [`commitment:${c.id}`]; j.payload.taskId = c.id; const prev = j.onSaved; j.onSaved = async (x) => { await prev(x); await db.update(commitments).set({ externalRefs: [...c.refs.filter((r) => r.provider !== x.provider), x] }).where(eq(commitments.id, c.id)); }; }
  }
  return runAll(target, jobs);
}

/** Recent audit rows, newest first (admin view). */
export const recentPushes = (limit = 50) => db.select().from(integrationPushes).orderBy(desc(integrationPushes.at)).limit(limit);
