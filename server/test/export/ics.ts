/** Minimal RFC 5545 check: CRLF, folded lines <= 75 octets, balanced BEGIN/END, required VTODO props. */
export function validateIcs(ics: string): string[] {
  const errs: string[] = [];
  if (!ics.endsWith("\r\n")) errs.push("must end with CRLF");
  if (/[^\r]\n/.test(ics)) errs.push("bare LF");
  const raw = ics.split("\r\n").slice(0, -1);
  for (const l of raw) if (Buffer.byteLength(l) > 75) errs.push(`line too long: ${l.slice(0, 20)}`);
  const lines: string[] = [];
  for (const l of raw) l.startsWith(" ") ? (lines[lines.length - 1] += l.slice(1)) : lines.push(l);
  const stack: string[] = [];
  for (const l of lines) {
    if (l.startsWith("BEGIN:")) stack.push(l.slice(6));
    else if (l.startsWith("END:")) { if (stack.pop() !== l.slice(4)) errs.push("unbalanced " + l); }
    else if (!/^[A-Z-]+(;[^:]*)?:/.test(l)) errs.push("bad content line: " + l);
  }
  if (stack.length) errs.push("unclosed " + stack.join());
  if (lines[0] !== "BEGIN:VCALENDAR" || !lines.includes("VERSION:2.0") || !lines.some((l) => l.startsWith("PRODID:"))) errs.push("missing calendar header");
  let i = 0;
  while ((i = lines.indexOf("BEGIN:VTODO", i)) >= 0) {
    const end = lines.indexOf("END:VTODO", i);
    const body = lines.slice(i, end);
    for (const p of ["UID:", "DTSTAMP:", "SUMMARY:"]) if (!body.some((l) => l.startsWith(p))) errs.push(`VTODO missing ${p}`);
    i = end;
  }
  return errs;
}

