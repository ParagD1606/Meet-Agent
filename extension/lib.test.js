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
  test("renderNotes renders the markdown subset and escapes HTML", () => {
    expect(L.renderNotes("## Decisions\n- Launch **Friday**\n- <img src=x onerror=alert(1)>\n\nplain")).toBe(
      "<h4>Decisions</h4><ul><li>Launch <b>Friday</b></li><li>&lt;img src=x onerror=alert(1)&gt;</li></ul><p>plain</p>");
  });
  test("mergeCaptions: growth, repeats of older on-screen captions and trimmed starts are one line each", () => {
    const lines = []; let t = 1000;
    const feed = (snap) => L.mergeCaptions(lines, snap, (t += 300));
    feed([{ speaker: "Ana", text: "Let's plan" }]);
    feed([{ speaker: "Ana", text: "Let's plan the launch." }]);
    feed([{ speaker: "Bob", text: "We decided" }, { speaker: "Ana", text: "Let's plan the launch." }]); // Ana's old caption still on screen
    feed([{ speaker: "Bob", text: "We decided to launch on Friday." }, { speaker: "Ana", text: "Let's plan the launch." }]);
    feed([{ speaker: "Ana", text: "The advertisement will be" }, { speaker: "Bob", text: "We decided to launch on Friday." }, { speaker: "Ana", text: "Let's plan the launch." }]);
    feed([{ speaker: "Ana", text: "The advertisement will be done by Parag." }, { speaker: "Bob", text: "We decided to launch on Friday." }]);
    expect(lines.map((l) => `${l.speaker}: ${l.text}`)).toEqual(["Ana: Let's plan the launch.", "Bob: We decided to launch on Friday.", "Ana: The advertisement will be done by Parag."]);
    // Meet drops the start of a long caption as it grows
    const long = []; let u = 5000; const f = (text) => L.mergeCaptions(long, [{ speaker: "Ana", text }], (u += 300));
    f("one two three four five six"); f("four five six seven eight nine"); f("seven eight nine ten eleven twelve");
    expect(long).toHaveLength(1);
    expect(long[0].text).toBe("one two three four five six seven eight nine ten eleven twelve");
  });
  test("mergeCaptions: the same words said again after the caption left the screen are new speech", () => {
    const lines = []; L.mergeCaptions(lines, [{ speaker: "Ana", text: "Sounds good." }], 1000);
    L.mergeCaptions(lines, [{ speaker: "Ana", text: "Sounds good." }], 60_000);
    expect(lines).toHaveLength(2);
  });
  test("mergeCaptions: the real Meet transcript, where earlier words are rewritten, stays one line", () => {
    const steps = [
      "Hello! Okay, so.",
      "Hello! Okay, so we will be. Skating. Outreach. So? Hello, so we will be scheduling our Outreach board.",
      "Hello! Okay, so we will be. Skating. Outreach. Hello, so we will be scaling our Outreach board. All right, so the task division will be. The advertisements. Is be handled by parag.",
      "Hello! Okay, so we will be. Skating. Outreach. Hello, so we will be scaling our Outreach board. All right, so the task division will be. The advertisements. Is be handled by parag. Talking part is done by ritesh. And technical part is done by Manas.",
    ];
    for (const withKey of [false, true]) {
      const lines = []; let t = 1000;
      for (const text of steps) L.mergeCaptions(lines, [{ speaker: "You", text, ...(withKey ? { key: 1 } : {}) }], (t += 400));
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe(steps[3]);
    }
  });
  test("mergeCaptions: a reused DOM node carrying new speech starts a new line", () => {
    const lines = []; let t = 1000;
    L.mergeCaptions(lines, [{ speaker: "Ana", text: "We should review the budget before Friday.", key: 7 }], (t += 400));
    L.mergeCaptions(lines, [{ speaker: "Ana", text: "Completely different sentence about lunch plans today.", key: 7 }], (t += 400));
    expect(lines.map((l) => l.text)).toEqual(["We should review the budget before Friday.", "Completely different sentence about lunch plans today."]);
  });
});
