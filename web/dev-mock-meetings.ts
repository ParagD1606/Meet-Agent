// Stateful in-memory mock of the meeting-to-execution endpoints (see web/lib/api.ts MeetingItem contract).
// Pasted transcripts go processing -> ready after MOCK_MEETING_MS (default 4000 ms).
import { MESSY_SAMPLE } from "./pages/meetings/samples"

const PEOPLE = [
  { id: "U1", name: "Ada Lovelace" }, { id: "U2", name: "Max Member" }, { id: "U5", name: "Marcus Webb" },
  { id: "U6", name: "Priya Nair" }, { id: "U7", name: "Priya Shah" }, { id: "U8", name: "Dana Ortiz" },
]
const DELAY = Number(process.env.MOCK_MEETING_MS ?? 4000)
const ymd = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
/** Next given weekday (0=Sun) strictly after today. */
const nextDow = (dow: number) => { const d = new Date(); d.setDate(d.getDate() + ((dow + 7 - d.getDay() - 1) % 7) + 1); return d.toISOString().slice(0, 10) }
let seq = 1

type Item = Record<string, any>
type Meeting = { id: string; title: string; platform: string; startedAt: string; status: "processing" | "ready" | "failed"; failedReason: string | null; text: string; summary: string | null; items: Item[] }

const parse = (text: string) => text.split("\n").filter((l) => l.trim()).map((l, i) => { const m = /^([^:]{1,40}):\s*(.*)$/.exec(l); return { n: i + 1, speaker: m ? m[1]!.trim() : "Speaker", text: m ? m[2]! : l.trim() } })

const amb = (o: Partial<Item> = {}) => ({ ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [], ...o })
const mk = (o: Item): Item => ({
  id: `it_${seq++}`, itemType: "task", title: "", description: "", assigneeId: null, assigneeName: null, dueDate: null, priority: "normal", kind: "commitment", label: "confirmed", confidence: 0.9,
  reason: "", quote: "", evidence: [], unverified: false, followUp: false, approval: "proposed", approvedBy: null, approvedAt: null, commitmentId: null, notification: null, externalRefs: [], ...o,
  ambiguity: { ...amb(), ...(o.ambiguity ?? {}), dueMissing: !o.dueDate && o.itemType !== "decision" && o.itemType !== "question" },
})

/** Hand-written analysis of the messy sample: duplicate, due conflict, ambiguous owner, suggestions, questions, unverified item. */
function messyItems(): Item[] {
  const fri = nextDow(5), mon = nextDow(1)
  return [
    mk({ title: "Draft the onboarding checklist", description: "For the audit evidence pack.", assigneeId: "U5", assigneeName: "Marcus Webb", dueDate: fri, confidence: 0.86, evidence: [4, 5], quote: "Yeah I can draft the onboarding checklist, probably by Friday.", reason: "Marcus accepted a direct request from Max and gave a date.",
      ambiguity: { duplicateOf: [{ source: "task", id: "cm3", title: "Draft the onboarding checklist", ownerName: "Max Member", dueDate: ymd(2) }] } }),
    mk({ title: "Review the data retention policy", assigneeId: "U6", assigneeName: "Priya Nair", dueDate: fri, confidence: 0.82, evidence: [8, 9, 10], quote: "Then Monday it is, but I wouldn't promise before that.", reason: "Priya volunteered for Friday, then Ada said legal needs it Monday.",
      ambiguity: { conflicts: [{ type: "due", with: { id: "it_ref", title: "Review the data retention policy (Priya, Monday)", ownerName: "Priya Nair", dueDate: mon } }] } }),
    mk({ title: "Update the audit tracker with the new evidence links", assigneeId: "U2", assigneeName: "Max Member", dueDate: ymd(1), confidence: 0.93, evidence: [20], quote: "I'll update the audit tracker with the new evidence links tomorrow.", reason: "First-person commitment with a relative date." }),
    mk({ title: "Send the retention summary to the auditors", confidence: 0.7, evidence: [21, 22], quote: "Sure, I'll send the summary once the review is done.", reason: "Priya agreed, but two people are named Priya.",
      ambiguity: { ownerAmbiguous: true, ownerCandidates: [{ id: "U6", name: "Priya Nair", score: 0.58 }, { id: "U7", name: "Priya Shah", score: 0.52 }] } }),
    mk({ title: "Send the audit scope doc to Dana", assigneeId: "U2", assigneeName: "Max Member", confidence: 0.88, evidence: [32, 33], quote: "Okay, I'll send it over.", reason: "Ada asked Max, Max confirmed. No deadline given." }),
    mk({ title: "Fix the EU invoice export", label: "tentative", confidence: 0.45, evidence: [11, 12], quote: "Someone should fix the EU invoice export before the audit window.", reason: "Nobody took it. 'Someone' is not an owner.",
      ambiguity: { ownerMissing: true, ownerCandidates: [{ id: "U5", name: "Marcus Webb", score: 0.4 }, { id: "U2", name: "Max Member", score: 0.33 }] } }),
    mk({ title: "Write up the root cause of the invoice export failure", label: "tentative", followUp: true, assigneeId: "U5", assigneeName: "Marcus Webb", confidence: 0.5, evidence: [31], quote: "I'll write up the root cause of the invoice export failure when I'm back from the offsite.", reason: "Committed, but the date is vague ('when I'm back')." }),
    mk({ title: "Tell customers about the export bug", label: "tentative", confidence: 0.3, unverified: true, evidence: [], quote: "", reason: "Inferred from a remark; no quote supports it.",
      ambiguity: { ownerMissing: true } }),
    mk({ title: "Move audit evidence into the shared drive", label: "suggestion", kind: "suggestion", confidence: 0.4, evidence: [13, 14], quote: "Maybe we should move the audit evidence into the shared drive instead of tickets?", reason: "Phrased as 'maybe we should'; Ada declined to decide.", ambiguity: { ownerMissing: true } }),
    mk({ title: "Automate evidence collection with a script", label: "suggestion", kind: "suggestion", confidence: 0.35, evidence: [23, 24], quote: "Maybe we could automate the evidence collection with a script.", reason: "Idea only; deferred past this quarter.", ambiguity: { ownerMissing: true } }),
    mk({ itemType: "question", title: "Who is our auditor contact?", kind: "question", label: "question", confidence: 0.9, evidence: [15, 16, 17], quote: "Does anyone know who the auditor contact is on our side?", reason: "Asked, then left unresolved." }),
    mk({ itemType: "question", title: "Migrate old customers before or after the audit?", kind: "question", label: "question", confidence: 0.85, evidence: [18, 19], quote: "Ada: Good question. We need pricing input and Sam is out, so parking it.", reason: "Parked until pricing input is available." }),
    mk({ itemType: "decision", title: "Keep audit evidence in tickets until Q3", kind: "commitment", label: "confirmed", confidence: 0.95, evidence: [25, 26], quote: "Decision: evidence stays in tickets until Q3.", reason: "Explicit decision from Ada." }),
  ]
}

/** Cheap heuristic for any other pasted text so the flow is demonstrable. */
function heuristicItems(text: string): Item[] {
  const items: Item[] = []
  const fri = nextDow(5)
  for (const l of parse(text)) {
    const who = PEOPLE.find((p) => p.name.split(" ")[0]!.toLowerCase() === l.speaker.toLowerCase())
    const due = /by (friday|next wednesday|monday)/i.test(l.text) ? fri : /\bthe (\d+)(th|st|nd|rd)\b/.test(l.text) ? ymd(5) : null
    if (/decision:/i.test(l.text)) items.push(mk({ itemType: "decision", title: l.text.replace(/^.*decision:\s*/i, "").replace(/\.$/, ""), confidence: 0.9, evidence: [l.n], quote: l.text, reason: "Explicit decision." }))
    else if (/\b(maybe we|should probably)\b/i.test(l.text)) items.push(mk({ title: l.text.replace(/^maybe we (should|could) /i, "").replace(/[?.]$/, ""), label: "suggestion", kind: "suggestion", confidence: 0.4, evidence: [l.n], quote: l.text, reason: "Hedged wording.", ambiguity: { ownerMissing: true } }))
    else if (/\bI('ll| will| can)\b/i.test(l.text) && who) items.push(mk({ title: l.text.replace(/^(yes|sure|will do|okay|got it)[,.]?\s*/i, "").replace(/^I('ll| will| can)\s*/i, "").replace(/^./, (c) => c.toUpperCase()).replace(/[.]$/, ""), assigneeId: who.id, assigneeName: who.name, dueDate: due, confidence: 0.85, evidence: [l.n], quote: l.text, reason: "First-person commitment." }))
    else if (l.text.endsWith("?") && /^(do we|are we|should we|is|what|who)/i.test(l.text)) items.push(mk({ itemType: "question", title: l.text, kind: "question", label: "question", confidence: 0.7, evidence: [l.n], quote: l.text, reason: "Open question." }))
  }
  return items
}

const db: { meetings: Meeting[]; mode: "auto" | "approve"; autoConfidence: number } = { meetings: [], mode: "auto", autoConfidence: 0.6 }
db.meetings.push(
  { id: "mx_1", title: "Audit and billing sync (messy sample)", platform: "paste", startedAt: new Date(Date.now() - 3600000).toISOString(), status: "ready", failedReason: null, text: MESSY_SAMPLE,
    summary: "The team reviewed the SOC 2 audit prep and the billing migration. Ada decided audit evidence stays in tickets until Q3. Several actions need owners or dates, and two questions remain open.", items: messyItems() },
  { id: "mx_2", title: "Customer call (failed)", platform: "extension", startedAt: new Date(Date.now() - 86400000).toISOString(), status: "failed", failedReason: "The model returned no usable output (rate limited). Try again in a minute.", text: "Ada: Hello.\nMax: Hi.", summary: null, items: [] },
)

const counts = (m: Meeting) => {
  const t = m.items.filter((i) => i.approval !== "rejected" && i.itemType === "task")
  return {
    confirmed: t.filter((i) => i.label === "confirmed").length, tentative: t.filter((i) => i.label === "tentative").length, suggestions: t.filter((i) => i.label === "suggestion").length,
    questions: m.items.filter((i) => i.itemType === "question").length, unassigned: t.filter((i) => !i.assigneeId).length, noDue: t.filter((i) => !i.dueDate).length,
    duplicates: t.filter((i) => i.ambiguity.duplicateOf.length).length, conflicts: t.filter((i) => i.ambiguity.conflicts.length).length,
  }
}
const row = (m: Meeting) => ({ id: m.id, title: m.title, platform: m.platform, startedAt: m.startedAt, status: m.status, failedReason: m.failedReason, counts: counts(m) })
const full = (m: Meeting, admin: boolean) => ({ ...row(m), summary: m.summary, items: m.items, lines: m.status === "processing" ? null : parse(m.text), counts: counts(m), canApprove: admin, mode: db.mode, autoConfidence: db.autoConfidence })

/** Auto mode: anything at/above the confidence threshold with an owner and a quote is assigned without review; duplicates auto-merge, conflicts only warn. */
const autoAssign = (m: Meeting) => {
  if (db.mode !== "auto") return
  m.items.filter((i) => i.itemType === "task" && i.kind === "commitment" && i.label !== "suggestion" && i.assigneeId && !i.unverified && !i.ambiguity.ownerAmbiguous && i.confidence >= db.autoConfidence)
    .forEach((i, n) => approveItem(i, n, "auto"))
}
const analyse = (m: Meeting) => {
  m.status = "processing"; m.failedReason = null
  setTimeout(() => {
    m.items = /SOC 2/.test(m.text) ? messyItems() : heuristicItems(m.text)
    m.summary = `Analysed ${parse(m.text).length} lines: ${m.items.filter((i) => i.itemType === "task").length} possible actions and ${m.items.filter((i) => i.itemType === "decision").length} decisions found.`
    autoAssign(m)
    m.status = "ready"
  }, DELAY)
}
const COMMITS = ["cm1", "cm2", "cm4"]
const approveItem = (it: Item, n: number, by = "Ada Lovelace") => {
  it.approval = "approved"; it.approvedBy = by; it.approvedAt = new Date().toISOString()
  if (it.itemType !== "task") return
  it.commitmentId = it.ambiguity.duplicateOf[0]?.id ?? COMMITS[n % COMMITS.length]
  it.notification = { status: "pending", error: null, sentAt: null }
  setTimeout(() => { it.notification = n % 3 === 2 ? { status: "failed", error: "Slack: cannot_dm_bot", sentAt: null } : { status: n % 3 === 1 ? "acknowledged" : "sent", error: null, sentAt: new Date().toISOString() } }, 1500)
  if (n % 2 === 0) it.externalRefs = [{ provider: "trello", id: `CARD-${40 + n}`, url: "https://trello.com/c/demo" }]
}

autoAssign(db.meetings[0]!)

/** Returns a Response when the path belongs to the meeting feature, else null. */
export function meetingRoutes(method: string, p: string, sp: URLSearchParams, body: Record<string, any>, admin: boolean): Response | null {
  const json = (d: unknown, s = 200) => Response.json(d, { status: s })
  let x: RegExpExecArray | null
  const m = (r: string) => new RegExp(`^${r}$`).exec(p)
  if (p === "/api/settings/meetings") {
    if (method === "PUT") { if (!admin) return json({ error: "forbidden" }, 403); if (body.mode) db.mode = body.mode === "auto" ? "auto" : "approve"; if (typeof body.autoConfidence === "number") db.autoConfidence = Math.min(0.95, Math.max(0.3, body.autoConfidence)) }
    return json({ mode: db.mode, autoConfidence: db.autoConfidence })
  }
  if (!p.startsWith("/api/meetings")) return null
  if (p === "/api/meetings" && method === "GET") return json(db.meetings.map(row))
  if (p === "/api/meetings" && method === "POST") {
    const text = body.text ?? (body.lines ?? []).map((l: any) => `${l.speaker ?? "Speaker"}: ${l.text}`).join("\n")
    if (!String(text).trim()) return json({ error: "invalid_body", issues: [{ path: "text", message: "Add some transcript text" }] }, 400)
    const mt: Meeting = { id: `mx_${++seq + 100}`, title: body.title || "Untitled meeting", platform: "paste", startedAt: body.startedAt ?? new Date().toISOString(), status: "processing", failedReason: null, text, summary: null, items: [] }
    db.meetings.unshift(mt); analyse(mt)
    return json({ id: mt.id }, 201)
  }
  if (p === "/api/meetings/extension-token") return json({ token: "cbx_demo_token_1234567890" })
  if (p === "/api/meetings/sync") return json({ found: 0, imported: 0, failed: 0 })
  const find = (id: string) => db.meetings.find((a) => a.id === id)
  const nf = () => json({ error: "not_found" }, 404)
  if ((x = m("/api/meetings/(\\w+)/assignees"))) return json(PEOPLE.filter((u) => !sp.get("q") || u.name.toLowerCase().includes(sp.get("q")!.toLowerCase())))
  if ((x = m("/api/meetings/(\\w+)/(reanalyze|retry)")) && method === "POST") { const mt = find(x[1]!); if (!mt) return nf(); analyse(mt); return json({ ok: true }) }
  if ((x = m("/api/meetings/(\\w+)/approve")) && method === "POST") {
    const mt = find(x[1]!); if (!mt) return nf(); if (!admin) return json({ error: "forbidden" }, 403)
    const ids: string[] | undefined = body.itemIds
    const pick = mt.items.filter((i) => i.approval === "proposed" && (ids ? ids.includes(i.id) : body.all === "confirmed" && i.label === "confirmed"))
    const bad = pick.find((i) => i.unverified || i.ambiguity.ownerMissing || i.ambiguity.ownerAmbiguous)
    if (bad && bad.itemType === "task") return json({ error: "needs_owner", message: `“${bad.title}” needs a clear owner and a supporting quote before approval.` }, 409)
    pick.forEach((i, n) => approveItem(i, n)); return json({ ok: true, approved: pick.length })
  }
  if ((x = m("/api/meetings/(\\w+)/recap")) && method === "POST") { const mt = find(x[1]!); if (!mt) return nf(); const n = mt.items.filter((i) => i.approval === "approved" && i.itemType === "task").length; return json({ sent: n, skipped: 0, failed: 0 }) }
  if ((x = m("/api/meetings/(\\w+)/items/(\\w+)/merge")) && method === "POST") { const mt = find(x[1]!); if (!mt) return nf(); mt.items = mt.items.filter((i) => i.id !== x![2]); return json({ ok: true }) }
  if ((x = m("/api/meetings/(\\w+)/items/(\\w+)/dismiss-duplicate")) && method === "POST") { const it = find(x[1]!)?.items.find((i) => i.id === x![2]); if (!it) return nf(); it.ambiguity.duplicateOf = []; return json({ ok: true }) }
  if ((x = m("/api/meetings/(\\w+)/items/(\\w+)")) && method === "PATCH") {
    const it = find(x[1]!)?.items.find((i) => i.id === x![2]); if (!it) return nf()
    if (body.title !== undefined && !String(body.title).trim()) return json({ error: "invalid_body", issues: [{ path: "title", message: "Title can't be empty" }] }, 400)
    for (const k of ["title", "description", "priority", "kind", "approval", "dueDate"]) if (k in body) it[k] = body[k]
    if ("dueDate" in body) it.ambiguity.dueMissing = !body.dueDate
    if ("assigneeId" in body) { const u = PEOPLE.find((u) => u.id === body.assigneeId); it.assigneeId = u?.id ?? null; it.assigneeName = u?.name ?? null; it.ambiguity.ownerMissing = !u; it.ambiguity.ownerAmbiguous = false }
    if (body.kind) it.label = body.kind === "suggestion" ? "suggestion" : body.kind === "question" ? "question" : it.label === "suggestion" ? "tentative" : it.label
    return json({ ok: true })
  }
  if ((x = m("/api/meetings/(\\w+)")) && method === "GET") { const mt = find(x[1]!); return mt ? json(full(mt, admin)) : nf() }
  return null
}
