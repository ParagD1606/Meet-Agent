import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resetDb } from "../db";
import { getBoss, Q, startJobs, stopJobs } from "../../src/jobs";
import { PROACTIVE_Q } from "../../src/automations/proactive";
import { MANAGER_Q } from "../../src/manager";
import { BOOTSTRAP_QUEUE } from "../../src/memory/bootstrap";
import { MEMORY_QUEUES } from "../../src/memory/observe";

const created = new Set<string>();
const worked = new Set<string>();
const scheduled = new Set<string>();

// every queue the codebase names. sync-all is registered inline in src/sync (no exported registry).
const ALL = [...Object.values(Q), ...Object.values(PROACTIVE_Q), ...Object.values(MANAGER_Q), ...Object.values(MEMORY_QUEUES), BOOTSTRAP_QUEUE, "sync-all"];
// queues with no cron: they only run when code enqueues them (producer must exist in src)
const PRODUCERS: Record<string, { file: string; call: string }> = {
  [Q.automationRun]: { file: "src/jobs.ts", call: "sendAfter(Q.automationRun" },
  [Q.researchRun]: { file: "src/jobs.ts", call: "send(Q.researchRun" },
  [Q.askDeliver]: { file: "src/jobs.ts", call: "sendAfter(Q.askDeliver" },
};

beforeAll(async () => {
  await resetDb();
  const b = getBoss() as any;
  for (const [m, set] of [["createQueue", created], ["work", worked], ["schedule", scheduled]] as const) {
    const orig = b[m].bind(b);
    b[m] = (name: string, ...rest: unknown[]) => { set.add(name); return orig(name, ...rest); };
  }
  await startJobs();
});
afterAll(stopJobs);

test("every registered queue has a createQueue, a consumer, and a schedule or a producer", () => {
  const names = [...new Set(ALL)];
  expect(names.length).toBeGreaterThan(15);
  for (const n of names) {
    expect({ n, created: created.has(n) }).toEqual({ n, created: true });
    expect({ n, worked: worked.has(n) }).toEqual({ n, worked: true });
    if (scheduled.has(n)) continue;
    const p = PRODUCERS[n];
    expect({ n, producer: p ? readFileSync(`${import.meta.dir}/../../${p.file}`, "utf8").includes(p.call) : false }).toEqual({ n, producer: true });
  }
});

test("nothing is consumed or scheduled that is missing from the registries", () => {
  for (const n of [...worked, ...scheduled]) expect({ n, known: ALL.includes(n) }).toEqual({ n, known: true });
});
