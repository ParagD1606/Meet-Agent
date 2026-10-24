import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { commitments, integrationPushes } from "../db/schema";
import { log } from "../log";
import { changeTask } from "../manager/task-sync";
import { ghx, isLimited, type Cred } from "./github-api";
import { githubCredential } from "./github-auth";

type Row = typeof integrationPushes.$inferSelect;
type Task = typeof commitments.$inferSelect;
export type ReconcileResult = { checked: number; taskClosed: number; issuesClosed: number; reopened: number; skipped: number; stopped?: string };

const CLOSED: Task["status"][] = ["done", "dropped"];
const BATCH = 100;
const KEEP_WATCHING_MS = 30 * 86_400_000; // ponytail: an in-sync closed pair is re-checked (for a reopen) for 30 days, then left alone

const parse = (url: string | null) => { const m = url?.match(/^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/); return m ? { repo: m[1]!, n: m[2]! } : null; };

const taskOf = async (ref: string): Promise<Task | null> => {
  const id = ref.startsWith("commitment:") ? ref.slice("commitment:".length) : null;
  const [c] = await db.select().from(commitments).where(id ? eq(commitments.id, id) : eq(commitments.sourceRef, ref));
  return c ?? null;
};
const mark = (row: Row, lastState?: "open" | "closed") =>
  db.update(integrationPushes).set({ syncedAt: new Date(), ...(lastState ? { lastState } : {}) }).where(eq(integrationPushes.id, row.id));

type One = "synced" | "taskClosed" | "issueClosed" | "reopened" | "skipped" | "stop:rate limited" | "stop:credentials rejected";

/**
 * One issue <-> task pair. `row.lastState` is the state both sides last agreed on: the side that differs from it is the one that
 * changed, and the other side is brought along. Both sides equal -> nothing to do, so a change can never bounce back.
 */
async function syncOne(row: Row, c: Task, cred: Cred): Promise<One> {
  const ref = parse(row.externalUrl);
  if (!ref) return "skipped";
  const base = `/repos/${ref.repo}/issues/${ref.n}`;
  const r = await ghx(cred.token, "GET", base);
  if (isLimited(r)) return "stop:rate limited";
  if (r.status === 401) return "stop:credentials rejected";
  if (r.status !== 200) { await mark(row); return "skipped"; } // 403/404/410: this credential cannot see the issue
  const issueS = r.data?.state === "closed" ? "closed" : "open";
  const taskS = CLOSED.includes(c.status) ? "closed" : "open";
  const last = row.lastState ?? "open";
  if (issueS === taskS) { await mark(row, issueS); return "synced"; }
  if (last === issueS) { // the task changed in Pixel
    const patch = await ghx(cred.token, "PATCH", base, taskS === "closed" ? { state: "closed", state_reason: c.status === "done" ? "completed" : "not_planned" } : { state: "open" });
    if (isLimited(patch)) return "stop:rate limited";
    if (patch.status !== 200) { await mark(row); return "skipped"; }
    const note = taskS === "closed" ? (c.status === "done" ? "Marked done in Pixel" : "Dropped in Pixel") : "Reopened in Pixel";
    await ghx(cred.token, "POST", `${base}/comments`, { body: note }).catch(() => null); // the state change is what matters
    await mark(row, taskS);
    return taskS === "closed" ? "issueClosed" : "reopened";
  }
  // the issue changed on GitHub
  const login = r.data?.closed_by?.login ?? r.data?.user?.login ?? "someone";
  const status = issueS === "closed" ? (r.data?.state_reason === "not_planned" ? "dropped" : "done") : "open";
  const res = await changeTask(c.id, { status }, { id: "github", admin: true }, { skipScope: true, note: issueS === "closed" ? `closed on GitHub by ${login}` : "reopened on GitHub" });
  if (!res.ok) { await mark(row); return "skipped"; }
  await mark(row, issueS);
  return issueS === "closed" ? "taskClosed" : "reopened";
}

/** Hourly job: bring up to 100 pushed issues in line with their tasks. Stops at the first rate limit or rejected credential. */
export async function reconcileGithub(limit = BATCH): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, taskClosed: 0, issuesClosed: 0, reopened: 0, skipped: 0 };
  const rows = await db.select().from(integrationPushes).where(and(
    eq(integrationPushes.target, "github"), eq(integrationPushes.status, "ok"),
    or(isNull(integrationPushes.lastState), eq(integrationPushes.lastState, "open"), gt(integrationPushes.syncedAt, new Date(Date.now() - KEEP_WATCHING_MS))),
  )).orderBy(sql`${integrationPushes.syncedAt} asc nulls first`, asc(integrationPushes.at)).limit(limit);
  const creds = new Map<string, Cred | null>();
  for (const row of rows) {
    const ref = parse(row.externalUrl), c = await taskOf(row.taskRef);
    if (!ref || !c) continue;
    if (!creds.has(ref.repo)) creds.set(ref.repo, await githubCredential(ref.repo).catch(() => null));
    const cred = creds.get(ref.repo);
    if (!cred) { out.skipped++; continue; }
    const r = await syncOne(row, c, cred).catch((e) => { log.warn("github reconcile failed", { err: e instanceof Error ? e.message.slice(0, 120) : "error" }); return "skipped" as const; });
    out.checked++;
    if (r.startsWith("stop:")) { out.stopped = r.slice(5); break; }
    if (r === "taskClosed") out.taskClosed++; else if (r === "issueClosed") out.issuesClosed++; else if (r === "reopened") out.reopened++; else if (r === "skipped") out.skipped++;
  }
  return out;
}

/** Best effort, right after a task is done / dropped / reopened in Pixel: bring its linked issue along. Never throws. */
export async function githubTaskChanged(taskId: string): Promise<void> {
  try {
    const [c] = await db.select().from(commitments).where(eq(commitments.id, taskId));
    if (!c) return;
    const rows = await db.select().from(integrationPushes).where(and(eq(integrationPushes.target, "github"), eq(integrationPushes.status, "ok"), inArray(integrationPushes.taskRef, [`commitment:${c.id}`, c.sourceRef])));
    for (const row of rows) {
      const ref = parse(row.externalUrl);
      const cred = ref && (await githubCredential(ref.repo));
      if (cred) await syncOne(row, c, cred);
    }
  } catch (e) { log.warn("github issue update failed", { err: e instanceof Error ? e.message.slice(0, 120) : "error" }); }
}
