import { createHash } from "node:crypto";

/** One exported task / meeting item, flat so every format shares it. `due` is ISO (date or datetime) or null. */
export type ExportRow = {
  id: string; source: string; itemType: string; title: string; assignee: string | null; due: string | null; priority: string; status: string;
  kind: string; label: string; confidence: string; approval: string; quote: string; link: string; externalUrl: string;
};

export const COLUMNS = ["source", "itemType", "title", "assignee", "due", "priority", "status", "kind", "label", "confidence", "approval", "quote", "link", "externalUrl"] as const;

// ---------- CSV (RFC 4180) ----------
/** A cell a spreadsheet would run as a formula gets a leading quote (OWASP CSV injection guidance). */
export const safeCell = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCell = (v: string): string => { const s = safeCell(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function toCsv(rows: ExportRow[], o: { bom?: boolean } = {}): string {
  const lines = [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => csvCell(String(r[c] ?? ""))).join(","))];
  return (o.bom ? "\uFEFF" : "") + lines.join("\r\n") + "\r\n";
}

export const toJson = (rows: ExportRow[], at = new Date()): string => JSON.stringify({ exportedAt: at.toISOString(), count: rows.length, items: rows }, null, 2) + "\n";

// ---------- Markdown, grouped by assignee ----------
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const mdText = (s: string) => oneLine(s).replace(/([\\`*_[\]<>])/g, "\\$1");
const httpUrl = (u: string) => (/^https?:\/\/\S+$/.test(u) ? u.replace(/[()]/g, encodeURIComponent) : "");

export function toMarkdown(rows: ExportRow[], o: { title?: string; at?: Date } = {}): string {
  const groups = new Map<string, ExportRow[]>();
  for (const r of rows) { const k = r.assignee?.trim() || "Unassigned"; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const keys = [...groups.keys()].sort((a, b) => (a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b)));
  const out = [`# ${mdText(o.title ?? "Task export")}`, "", `Exported ${(o.at ?? new Date()).toISOString().slice(0, 10)} · ${rows.length} items`];
  for (const k of keys) {
    out.push("", `## ${mdText(k)} (${groups.get(k)!.length})`, "");
    for (const r of groups.get(k)!) {
      const done = r.status === "done" ? "x" : " ";
      const bits = [r.due ? `due ${r.due.slice(0, 10)}` : "", r.priority === "urgent" ? "urgent" : "", r.source ? mdText(r.source) : ""].filter(Boolean);
      const links = [httpUrl(r.link) && `[source](${httpUrl(r.link)})`, httpUrl(r.externalUrl) && `[board](${httpUrl(r.externalUrl)})`].filter(Boolean);
      out.push(`- [${done}] ${mdText(r.title)}${bits.length ? ` _(${bits.join(", ")})_` : ""}${links.length ? ` ${links.join(" ")}` : ""}`);
      if (r.quote) out.push(`  > ${mdText(r.quote)}`);
    }
  }
  return out.join("\n") + "\n";
}

// ---------- iCalendar (RFC 5545) VTODO ----------
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n|\r/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

/** Folds a content line at 75 octets, never inside a multi-byte character; continuation lines start with one space. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const dueProp = (due: string): string | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return `DUE;VALUE=DATE:${due.replace(/-/g, "")}`;
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : `DUE:${stamp(d)}`;
};

export function toIcs(rows: ExportRow[], at = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Company Brain//Task export//EN", "CALSCALE:GREGORIAN"];
  for (const r of rows) {
    // the UID is a hash of the row id, so re-importing an updated export updates the same todo
    const desc = [r.assignee && `Owner: ${r.assignee}`, r.quote && `"${r.quote}"`, r.externalUrl].filter(Boolean).join("\n");
    const due = r.due ? dueProp(r.due) : null;
    lines.push(
      "BEGIN:VTODO", `UID:${createHash("sha1").update(r.id).digest("hex")}@company-brain`, `DTSTAMP:${stamp(at)}`, `SUMMARY:${icsText(r.title)}`,
      ...(due ? [due] : []), ...(desc ? [`DESCRIPTION:${icsText(desc)}`] : []), ...(httpUrl(r.link) ? [`URL:${httpUrl(r.link)}`] : []),
      `PRIORITY:${r.priority === "urgent" ? 1 : 5}`,
      `STATUS:${r.status === "done" ? "COMPLETED" : r.status === "dropped" || r.approval === "rejected" ? "CANCELLED" : r.status === "in_progress" ? "IN-PROCESS" : "NEEDS-ACTION"}`,
      "END:VTODO",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------- dispatch ----------
export const FORMATS = { csv: { type: "text/csv", ext: "csv" }, json: { type: "application/json", ext: "json" }, md: { type: "text/markdown", ext: "md" }, ics: { type: "text/calendar", ext: "ics" } } as const;
export type Format = keyof typeof FORMATS;

export function render(format: Format, rows: ExportRow[], o: { title?: string; at?: Date; bom?: boolean } = {}): string {
  switch (format) {
    case "csv": return toCsv(rows, { bom: o.bom ?? true });
    case "json": return toJson(rows, o.at);
    case "md": return toMarkdown(rows, o);
    case "ics": return toIcs(rows, o.at);
  }
}
