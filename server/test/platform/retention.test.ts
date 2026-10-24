import { beforeAll, expect, test } from "bun:test";
import { pool, resetDb } from "../db";
import { purgeOld } from "../../src/jobs";

const count = async (t: string) => Number((await pool.query(`select count(*) n from ${t}`)).rows[0].n);
const ago = (d: number) => `now() - interval '${d} days'`;

beforeAll(async () => {
  await resetDb();
  const q = (s: string) => pool.query(s);
  await q(`insert into recall_log (channel_id, thread_key, message_ts, query, created_at) values ('C','t','1','q',${ago(31)}),('C','t','2','q',${ago(1)})`);
  await q(`insert into ambient_messages (channel_id, ts, flushed_at, created_at) values
    ('C','1',now(),${ago(15)}),('C','2',now(),${ago(1)}),('C','3',null,${ago(20)})`); // old flushed goes; recent flushed and old unflushed stay
  await q(`insert into follow_ups (id, owner_id, text, due_at, status) values
    ('f1','U','x',${ago(91)},'sent'),('f2','U','x',${ago(91)},'pending'),('f3','U','x',${ago(10)},'cancelled')`);
  await q(`insert into commitments (id, text, source_type, source_ref, scope_tag, status, created_at, completed_at) values
    ('c1','x','message','a','shared','done',${ago(300)},${ago(181)}),('c2','x','message','b','shared','dropped',${ago(181)},null),
    ('c3','x','message','c','shared','open',${ago(300)},null),('c4','x','message','d','shared','done',${ago(300)},${ago(5)})`);
  await q(`insert into consolidation_log (run_id, action, created_at, undone_at) values
    ('old-undone','merge',${ago(120)},now()),('old-newest-undoable','merge',${ago(100)},null),('old-undoable-older','merge',${ago(110)},null)`);
  await q(`insert into manager_risks (key, posted_at) values ('r1',${ago(91)}),('r2',${ago(1)})`);
  await q(`insert into memory_reminders (memory_id, channel_id, reminded_at) values (1,'C',${ago(61)}),(2,'C',${ago(1)})`);
  await q(`insert into capture_buffer (channel_id, thread_ts, scope, attempts, last_at) values
    ('C','1','{}',3,${ago(8)}),('C','2','{}',1,${ago(8)}),('C','3','{}',3,${ago(1)})`);
});

test("purgeOld deletes only what is past retention", async () => {
  const r = await purgeOld();
  expect(r).toMatchObject({ recallLog: 1, ambientMessages: 1, followUps: 1, commitments: 2, managerRisks: 1, memoryReminders: 1, captureBuffer: 1 });
  expect(await count("recall_log")).toBe(1);
  expect(await count("ambient_messages")).toBe(2);
  expect(await count("follow_ups")).toBe(2);
  expect(await count("commitments")).toBe(2);
  expect(await count("capture_buffer")).toBe(2);
  // the undone old run and the older undoable run go; the newest undoable run (even though past 90d) stays
  expect(r.consolidationLog).toBe(2);
  const left = (await pool.query("select run_id from consolidation_log order by run_id")).rows.map((x) => x.run_id);
  expect(left).toEqual(["old-newest-undoable"]);
});

test("purgeOld is idempotent", async () => {
  const r = await purgeOld();
  for (const k of ["recallLog", "ambientMessages", "followUps", "commitments", "consolidationLog", "managerRisks", "memoryReminders", "captureBuffer"]) expect(r[k]).toBe(0);
});
