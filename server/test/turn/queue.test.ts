import "./env";
import { describe, expect, test } from "bun:test";
import { enqueue, serialize, withAdvisoryLock } from "../../src/turn/queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("enqueue", () => {
  test("same key runs strictly in order, never overlapping", async () => {
    const log: string[] = [];
    let running = 0, maxRunning = 0;
    const job = (name: string, ms: number) => enqueue("k", async () => {
      running++; maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); running--;
    });
    await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(maxRunning).toBe(1);
  });

  test("different keys run in parallel", async () => {
    let running = 0, maxRunning = 0;
    const job = (k: string) => enqueue(k, async () => { running++; maxRunning = Math.max(maxRunning, running); await sleep(20); running--; });
    await Promise.all([job("x"), job("y"), job("z")]);
    expect(maxRunning).toBe(3);
  });

  test("a failing job rejects its caller but does not block the next", async () => {
    const bad = enqueue("f", async () => { throw new Error("boom"); });
    const good = enqueue("f", async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    expect(await good).toBe("ok");
  });
});

describe("advisory lock", () => {
  test("excludes concurrent holders of the same key across connections", async () => {
    const log: string[] = [];
    const hold = (name: string) => withAdvisoryLock("lock-test", async () => { log.push(`s${name}`); await sleep(40); log.push(`e${name}`); });
    await Promise.all([hold("1"), hold("2")]);
    expect(log[1]).toMatch(/^e/); // first holder finished before the second started
    expect(log[2]).toMatch(/^s/);
  });

  test("releases on error so the key is reusable", async () => {
    await expect(withAdvisoryLock("lock-err", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await withAdvisoryLock("lock-err", async () => 1)).toBe(1);
  });

  test("serialize composes both", async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => serialize("ser", async () => { await sleep(10 - i * 3); order.push(i); })));
    expect(order).toEqual([1, 2, 3]);
  });
});
