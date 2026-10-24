import { describe, expect, test } from "bun:test";
import { validateIcs } from "./ics";
import { foldLine, toCsv, toIcs, toJson, toMarkdown, type ExportRow } from "../../src/export/format";

const row = (o: Partial<ExportRow> = {}): ExportRow => ({
  id: "commitment:cm_1", source: "#eng", itemType: "task", title: "Ship it", assignee: "Ada", due: "2026-11-02T00:00:00.000Z", priority: "normal", status: "open",
  kind: "commitment", label: "", confidence: "", approval: "approved", quote: "", link: "https://slack.example/p1", externalUrl: "", ...o,
});

describe("toCsv", () => {
  test("RFC 4180 quoting: commas, quotes, newlines, unicode; CRLF; header", () => {
    const csv = toCsv([row({ title: 'Say "hi", then\nleave', assignee: "Zoë 日本" })]);
    expect(csv.startsWith("source,itemType,title,assignee,due,")).toBe(true);
    expect(csv).toContain('"Say ""hi"", then\nleave"');
    expect(csv).toContain("Zoë 日本");
    expect(csv.split("\r\n")).toHaveLength(3);
  });
  test("BOM only when asked", () => {
    expect(toCsv([row()], { bom: true }).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv([row()]).charCodeAt(0)).not.toBe(0xfeff);
  });
  test("formula-injection cells get a leading single quote", () => {
    const csv = toCsv([row({ title: "=HYPERLINK(\"http://evil\")", assignee: "+1-555", quote: "-2+3", label: "@SUM(A1)", kind: "\tcmd" })]);
    for (const bad of ["'=HYPERLINK", "'+1-555", "'-2+3", "'@SUM(A1)", "'\tcmd"]) expect(csv).toContain(bad);
    // a quoted cell starting with a quote char must not start with = + - @ underneath
    expect(csv).not.toMatch(/(^|,)"?[=+@]/m);
  });
});

describe("toJson / toMarkdown", () => {
  test("json is parseable with count", () => {
    const j = JSON.parse(toJson([row(), row({ id: "x" })], new Date("2026-10-24T00:00:00Z")));
    expect(j).toMatchObject({ exportedAt: "2026-10-24T00:00:00.000Z", count: 2 });
    expect(j.items[0].title).toBe("Ship it");
  });
  test("markdown groups by assignee (Unassigned last), shows due and links, escapes markup", () => {
    const md = toMarkdown([row({ assignee: "Zed", title: "B *bold*" }), row({ id: "2", assignee: null, title: "Nobody" }), row({ id: "3", title: "A", status: "done", externalUrl: "https://trello.com/c/x" })], { at: new Date("2026-10-24T00:00:00Z") });
    expect(md.indexOf("## Ada")).toBeLessThan(md.indexOf("## Zed"));
    expect(md.indexOf("## Zed")).toBeLessThan(md.indexOf("## Unassigned"));
    expect(md).toContain("- [x] A _(due 2026-11-02, #eng)_ [source](https://slack.example/p1) [board](https://trello.com/c/x)");
    expect(md).toContain("B \\*bold\\*");
  });
  test("javascript: links are not emitted", () => {
    expect(toMarkdown([row({ link: "javascript:alert(1)" })])).not.toContain("javascript:");
  });
});

describe("toIcs", () => {
  const at = new Date("2026-10-24T10:00:00Z");
  test("valid calendar, stable UID, date and datetime due", () => {
    const rows = [row(), row({ id: "m:1", due: "2026-12-01", title: "Café, ünïcode; with \\ and\nnewline " + "long ".repeat(30), priority: "urgent", status: "in_progress" }), row({ id: "m:2", due: null, status: "done" })];
    const a = toIcs(rows, at), b = toIcs(rows, new Date());
    expect(validateIcs(a)).toEqual([]);
    expect(a).toContain("DUE:20261102T000000Z");
    expect(a).toContain("DUE;VALUE=DATE:20261201");
    expect(a).toContain("PRIORITY:1");
    expect(a).toContain("STATUS:COMPLETED");
    expect(a).toContain("STATUS:IN-PROCESS");
    const uids = (s: string) => s.match(/UID:\S+/g);
    expect(uids(a)).toEqual(uids(b));
    expect(new Set(uids(a)).size).toBe(3);
    expect(a).toContain("\\,");
    expect(a).toContain("\\;");
    expect(a).toContain("\\n");
  });
  test("folding never splits a multi-byte character", () => {
    const folded = foldLine("SUMMARY:" + "日本語".repeat(40));
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n ").join("")).toBe("SUMMARY:" + "日本語".repeat(40));
    expect(folded).not.toContain("�");
  });
  test("empty export is still a valid calendar", () => { expect(validateIcs(toIcs([], at))).toEqual([]); });
});
