import { describe, expect, test } from "bun:test";
import { asItems, autoApproves, counts, crossCheck, cues, emptyAmbiguity, normalizeDue, type MeetingItem } from "../../src/meetings/items";
import { recapBullets } from "../../src/meetings/recap";

const item = (o: Partial<MeetingItem> = {}): MeetingItem => ({
  id: "i1", itemType: "task", title: "Send the deck", description: "", assigneeId: "U1", assigneeName: "Ana", dueDate: null, priority: "normal", kind: "commitment", label: "confirmed",
  confidence: 0.9, reason: "", quote: "I'll send the deck", evidence: [], unverified: false, followUp: false, ambiguity: emptyAmbiguity(), commitmentId: null, externalRefs: [], ...o,
});

describe("modal-cue cross-check (gold phrases)", () => {
  const gold: [string, "commitment" | "suggestion", number][] = [
    ["I'll send the revised deck by Friday", "commitment", 0.7],
    ["Parag, you take the ads", "commitment", 0.7],
    ["Eve will handle the venue", "commitment", 0.7],
    ["We could maybe redo the logo", "suggestion", 0],
    ["Someone should check the contract", "suggestion", 0],
    ["I think I can maybe look at it", "suggestion", 0],
    ["We should probably update the docs", "suggestion", 0],
    ["Should we move the launch?", "suggestion", 0],
  ];
  for (const [quote, kind] of gold) {
    test(`"${quote}" -> ${kind}`, () => {
      const out = crossCheck(item({ quote, title: quote, confidence: 0.9 })); // an over-confident model
      expect(out.kind).toBe(kind);
      if (kind === "suggestion") expect(out.confidence).toBeLessThanOrEqual(0.45);
    });
  }
  test("a hedge next to a firm cue keeps the item but makes it tentative (<= 0.65)", () => {
    const out = crossCheck(item({ quote: "I'll try to send the deck", confidence: 0.95 }));
    expect(out).toMatchObject({ kind: "commitment", label: "tentative" });
    expect(out.confidence).toBeLessThanOrEqual(0.65);
  });
  test("firm words with an owner and a date are scored at least 0.8; without a date 0.7", () => {
    expect(crossCheck(item({ quote: "I'll send the deck by Friday", dueDate: "2026-10-30", confidence: 0.55 })).confidence).toBe(0.8);
    expect(crossCheck(item({ quote: "I'll send the deck", dueDate: null, confidence: 0.55 })).confidence).toBe(0.7);
    expect(crossCheck(item({ quote: "I'll send the deck", assigneeId: null, confidence: 0.55 })).confidence).toBe(0.55); // no owner: never raised
  });
  test("it never raises a suggestion and never touches decisions or questions", () => {
    expect(crossCheck(item({ kind: "suggestion", label: "confirmed", quote: "we could do it" })).label).toBe("suggestion");
    expect(crossCheck(item({ itemType: "decision", quote: "maybe" })).kind).toBe("commitment");
    expect(cues("we might").weak).toBe(true);
  });
});

describe("auto gate (threshold boundary)", () => {
  test("0.59 waits, 0.6 and 0.61 are assigned", () => {
    expect(autoApproves(item({ confidence: 0.59 }), "auto", 0.6)).toBe(false);
    expect(autoApproves(item({ confidence: 0.6 }), "auto", 0.6)).toBe(true);
    expect(autoApproves(item({ confidence: 0.61 }), "auto", 0.6)).toBe(true);
  });
  test("unverified, ownerless, ambiguous owner, suggestions and questions are never auto-approved; duplicates and conflicts do not block", () => {
    expect(autoApproves(item({ unverified: true }), "auto")).toBe(false);
    expect(autoApproves(item({ assigneeId: null }), "auto")).toBe(false);
    expect(autoApproves(item({ ambiguity: { ...emptyAmbiguity(), ownerAmbiguous: true } }), "auto")).toBe(false);
    expect(autoApproves(item({ kind: "suggestion" }), "auto")).toBe(false);
    expect(autoApproves(item({ itemType: "question", kind: "question", assigneeId: null }), "auto")).toBe(false);
    expect(autoApproves(item({ ambiguity: { ...emptyAmbiguity(), duplicateOf: [{ source: "task", id: "c", title: "x", ownerName: null, dueDate: null }] } }), "auto")).toBe(true);
    expect(autoApproves(item({ ambiguity: { ...emptyAmbiguity(), conflicts: [{ type: "due", with: { id: "c", title: "x", ownerName: null, dueDate: null } }] } }), "auto")).toBe(true);
    expect(autoApproves(item(), "approve")).toBe(false); // approve mode: nothing is automatic
  });
});

describe("due dates", () => {
  const sat = new Date("2026-10-24T10:00:00Z"); // a Saturday
  test("relative words resolve against the meeting date", () => {
    expect(normalizeDue("Friday", sat)).toBe("2026-10-30");
    expect(normalizeDue("by next Wednesday", sat)).toBe("2026-11-04");
    expect(normalizeDue("tomorrow", sat)).toBe("2026-10-25");
    expect(normalizeDue("in 2 weeks", sat)).toBe("2026-11-07");
    expect(normalizeDue("Oct 30", sat)).toBe("2026-10-30");
    expect(normalizeDue("5 Jan", sat)).toBe("2027-01-05");
    expect(normalizeDue("2026-11-02", sat)).toBe("2026-11-02");
    expect(normalizeDue("2026-02-31", sat)).toBeNull();
    expect(normalizeDue("sometime soon", sat)).toBeNull();
    expect(normalizeDue(null, sat)).toBeNull();
  });
});

describe("items and recap helpers", () => {
  test("old rows become full items without losing the old quote line", () => {
    const [t] = asItems("mt1", [{ title: "Old task", description: "ctx\nSaid: “I will do it”", assigneeId: "U1", dueDate: null }]);
    expect(t).toMatchObject({ itemType: "task", kind: "commitment", quote: "I will do it", description: "ctx", unverified: false });
    expect(t!.approval).toBeUndefined();
    expect(t!.id).toMatch(/^mtask_/);
  });
  test("counts", () => {
    const c = counts([item(), item({ id: "b", label: "tentative", assigneeId: null }), item({ id: "c", itemType: "question", kind: "question" }), item({ id: "d", approval: "rejected" })]);
    expect(c).toMatchObject({ confirmed: 1, tentative: 1, questions: 1, unassigned: 1, noDue: 2 });
  });
  test("recap bullets: decisions first, 3-6 bullets, under 1200 chars, no secrets", () => {
    const b = recapBullets("## Discussion\n- point one\n- point two\n- the api key: sk-abcdef0123456789abcdef leaked\n- point four\n## Open questions\n- who pays?", ["Use plan A"]);
    expect(b[0]).toBe("Decision: Use plan A");
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b.length).toBeLessThanOrEqual(6);
    expect(b.join("")).not.toContain("sk-abcdef");
    expect(b.some((x) => x.startsWith("Open question"))).toBe(true);
    expect(b.join("").length).toBeLessThan(1200);
    expect(recapBullets("We agreed to ship. Then we left.", [])[0]).toBe("We agreed to ship.");
  });
});
