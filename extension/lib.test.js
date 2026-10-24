import { describe, expect, test } from "bun:test";
const L = require("./lib.js");

describe("extension lib", () => {
  test("parseTranscript handles plain, timestamped and VTT text", () => {
    expect(L.parseTranscript("Ana: ship it\n[10:02] Bob: ok\nsecond line")).toEqual([
      { speaker: "Ana", text: "ship it" }, { speaker: "Bob", text: "ok second line" }]);
    expect(L.parseTranscript("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<v Ana>Hello there</v>")[0]).toEqual({ speaker: "Ana", text: "Hello there" });
  });
  test("findDuplicates flags near-identical titles and deadline conflicts", () => {
    const items = [
      { id: "a", kind: "task", title: "Send the Q3 budget deck to finance", due: "2026-10-30", status: "approved" },
      { id: "b", kind: "task", title: "Send Q3 budget deck to the finance team", due: "2026-11-02", status: "pending" },
      { id: "c", kind: "task", title: "Book the offsite venue", due: "", status: "pending" },
    ];
    const d = L.findDuplicates(items);
    expect(d.b).toEqual({ otherId: "a", conflict: true });
    expect(d.c).toBeUndefined();
    expect(L.findDuplicates([{ ...items[0] }, { ...items[1], status: "rejected" }])).toEqual({});
  });
  test("workload hint suggests the lightest teammate only when someone is loaded", () => {
    const load = L.workload([{ items: Array.from({ length: 5 }, (_, i) => ({ id: i, kind: "task", status: "approved", assignee: "Rahul" })) }, { items: [{ kind: "task", status: "approved", assignee: "Priya" }] }]);
    expect(L.workloadHint("Rahul", load, ["Rahul", "Priya", "Sam"])).toEqual({ count: 5, alt: "Sam", altCount: 0 });
    expect(L.workloadHint("Priya", load, ["Rahul", "Priya"])).toBeNull();
  });
  test("migrate converts the old store and keeps new ones", () => {
    const m = L.migrate({ decisions: [{ id: "d", text: "Go" }], tasks: [{ id: "t", title: "Do", assignee: "Ana", due: "Fri", done: true }] });
    expect(m.items.map((i) => [i.kind, i.status, i.done])).toEqual([["decision", "approved", false], ["task", "approved", true]]);
    const n = { items: [] }; expect(L.migrate(n)).toBe(n);
  });
  test("dueChips resolves Friday relative to the date", () => {
    const chips = Object.fromEntries(L.dueChips(new Date("2026-10-24T10:00:00Z"))); // a Saturday
    expect(chips.Friday).toBe("2026-10-30"); expect(chips.Tomorrow).toBe("2026-10-25");
  });
  test("badge labels", () => {
    expect(L.badge({ kind: "question", label: "suggestion" })).toBe("Open question");
    expect(L.badge({ kind: "task", label: "tentative" })).toBe("Tentative");
  });
});
