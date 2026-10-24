import type { ReactNode } from "react"

const svg = (d: string, size = 22, stroke = "currentColor") => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
)
export const I = {
  brain: (s = 18) => svg("M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5 4 4 0 0 0 8 0 3 3 0 0 0 2-5 3 3 0 0 0-2-5V7a4 4 0 0 0-4-4z|M12 3v18", s, "#04110f"),
  caption: (s = 22) => svg("M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z|M8 11h2M14 11h2M8 15h5", s),
  check: (s = 22) => svg("M9 11l3 3 8-8|M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9", s),
  people: (s = 22) => svg("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M22 21v-2a4 4 0 0 0-3-3.9|M16 3.1a4 4 0 0 1 0 7.8", s),
  chat: (s = 22) => svg("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z", s),
  memory: (s = 22) => svg("M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2z|M4 6v6c0 1.1 3.6 2 8 2s8-.9 8-2V6|M4 12v6c0 1.1 3.6 2 8 2s8-.9 8-2v-6", s),
  lock: (s = 22) => svg("M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z|M8 11V8a4 4 0 0 1 8 0v3", s),
  globe: (s = 22) => svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M3 12h18|M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z", s),
  user: (s = 22) => svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M4 21a8 8 0 0 1 16 0", s),
  bolt: (s = 22) => svg("M13 3 5 13.5h6L10 21l8-10.5h-6z", s),
  server: (s = 22) => svg("M4 5h16v6H4z|M4 13h16v6H4z|M8 8h.01M8 16h.01", s),
  export: (s = 22) => svg("M12 3v12|M8 7l4-4 4 4|M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4", s),
  arrow: (s = 18) => svg("M5 12h14|M13 6l6 6-6 6", s),
  down: (s = 18) => svg("M12 5v14|M6 13l6 6 6-6", s),
  slack: (s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden><path fill="#E01E5A" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52zM6.31 15.16a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 1 1-5.04 0z" /><path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52zM8.83 6.31a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04z" /><path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52zM17.69 8.83a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0z" /><path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52zM15.17 17.69a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04z" /></svg>
  ),
}

const AV: Record<string, string> = { Ana: "#0d9488", Bob: "#b45309", Parag: "#7c3aed", Manas: "#be185d", Ritesh: "#2563eb" }
const Av = ({ n }: { n: string }) => <span className="av" style={{ background: AV[n] ?? "#475569" }}>{n[0]}</span>

export const LINES: { who: string; t: ReactNode; hl?: boolean }[] = [
  { who: "Ana", t: "Let's plan the launch." },
  { who: "Bob", t: <>We <mark>decided to launch on Friday</mark>.</>, hl: true },
  { who: "Ana", t: <>The advertisements are <mark>handled by Parag</mark>.</>, hl: true },
  { who: "Parag", t: "Yes, I will handle it." },
]

const TABS = ["Live", "Notes", "Items", "Suggest", "Ask"]
export function PanelMock({ mode }: { mode: "hero" | "how" }) {
  return (
    <div className="pm" data-pm={mode}>
      <div className="pm-head">
        <span className="pm-logo">{I.brain()}</span>
        <div><div className="pm-title">Google Meet · Q4 launch sync</div><div className="pm-sub"><i className="pm-dot" />meet · <span className="pm-count">0</span> lines · 3 speakers</div></div>
      </div>
      <div className="pm-tabs">{TABS.map((t, i) => <span key={t} className={i === 0 ? "on" : ""} data-tab={i}>{t}{t === "Items" && <b className="pm-bdg">3</b>}</span>)}</div>
      <div className="pm-body">
        <div className="pm-view" data-view="0">
          {LINES.map((l, i) => (
            <div key={i} className={`ln${l.hl ? " hl" : ""}`}><Av n={l.who} /><div><div className="who">{l.who}<em>11:{16 + i} AM</em></div><div className="say">{l.t}</div></div></div>
          ))}
        </div>
        {mode === "how" && (<>
          <div className="pm-view note" data-view="1">
            <h5>Topics</h5>
            <ul><li>Planning the Friday launch</li><li>Who owns advertising and the talking part</li></ul>
            <h5>Open questions</h5>
            <ul><li>Which browser do most users have?</li></ul>
            <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>updated every 2 min · topics only</div>
          </div>
          <div className="pm-view" data-view="2">
            <div className="it"><span className="badge">Task</span> <span className="badge t">✓ quote found</span><div className="t">Handle the advertisements</div><div className="m">“handled by Parag” · line 3</div></div>
            <div className="it dec"><span className="badge v">Decision</span> <span className="badge t">✓ quote found</span><div className="t">Launch on Friday</div><div className="m">“decided to launch on Friday” · line 2</div></div>
            <div className="it q"><span className="badge c">Open question</span><div className="t">Which browser do most users have?</div><div className="m">Asked, not answered</div></div>
          </div>
          <div className="pm-view" data-view="3">
            <div style={{ fontWeight: 650, fontSize: 13 }}>Write the user guide <span className="pill b" style={{ marginLeft: 6 }}>Due Fri</span></div>
            {[["Ana", "Technical writer", "Wrote the last two guides (8 days ago)", "Light load"], ["Bob", "", "No evidence of related experience found", "Busy"]].map(([n, r, why, load]) => (
              <div className="cand" key={n}><Av n={n!} /><div><div className="nm">{n}</div><div className="tt">{r}</div></div><span className="go">Assign</span><div className="why"><span className={`pill${load === "Busy" ? " b" : ""}`}>{load}</span>{why}</div></div>
            ))}
          </div>
          <div className="pm-view sent" data-view="4">
            <h5>Final notes</h5>
            <div className="site">
              <div className="row"><span>Decision</span><span>Launch on Friday</span></div>
              <div className="row"><span><span className="tick">✓</span> Parag</span><span>Handle the advertisements</span></div>
              <div className="row"><span><span className="tick">✓</span> Ana</span><span>Write the user guide</span></div>
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>saved to Meeting notes · remembered for you</div>
          </div>
        </>)}
      </div>
    </div>
  )
}

export const STEPS = [
  { n: "01", h: "Captions become a transcript", p: "Turn on captions in Meet, Teams, Zoom or Slack in your browser. The side panel reads them live, with real speaker names. No bot joins your call and no audio is recorded." },
  { n: "02", h: "Live notes, every two minutes", p: "Running topics and open questions refresh while the call goes. Decisions and tasks deliberately wait: they are not guessed halfway through a conversation." },
  { n: "03", h: "Decisions and tasks, from the whole meeting", p: "One pass over the full transcript. Every item must quote what was actually said, or it is dropped. Nothing is saved until you approve it." },
  { n: "04", h: "The right owner, with receipts", p: "Suggestions weigh who has done similar work and who can finish before the deadline, citing real tasks and notes instead of guessing." },
  { n: "05", h: "Saved, and remembered", p: "Approved items land in Meeting notes with real owners, then become memory your team can ask about next week." },
]

export const GRAPH = {
  nodes: [
    { id: "thread", label: "#launch-plan thread", x: 150, y: 110, c: "#2dd4bf" },
    { id: "huddle", label: "Huddle notes", x: 110, y: 330, c: "#8b5cf6" },
    { id: "meet", label: "Q4 sync · Meet", x: 330, y: 445, c: "#8b5cf6" },
    { id: "dec", label: "Decision: launch Friday", x: 385, y: 215, c: "#fbbf24" },
    { id: "ads", label: "Task: advertisements", x: 640, y: 105, c: "#4ade80" },
    { id: "db", label: "Task: database", x: 690, y: 330, c: "#4ade80" },
    { id: "parag", label: "Parag", x: 560, y: 235, c: "#f472b6" },
    { id: "manas", label: "Manas", x: 625, y: 462, c: "#f472b6" },
    { id: "doc", label: "Launch plan (Drive)", x: 275, y: 40, c: "#22d3ee" },
    { id: "aws", label: "Fact: AWS until Dec", x: 55, y: 215, c: "#2dd4bf" },
  ],
  edges: [["thread", "dec"], ["huddle", "dec"], ["meet", "dec"], ["meet", "ads"], ["meet", "db"], ["ads", "parag"], ["db", "manas"], ["doc", "dec"], ["aws", "huddle"], ["thread", "aws"], ["meet", "manas"], ["dec", "parag"]] as [string, string][],
}

export const SCOPES = [
  { h: "Shared", p: "Public channels write to shared memory that everyone in the workspace can search.", c: "#2dd4bf", icon: I.globe },
  { h: "Private channels", p: "Private channels stay inside the channel: only its members can ever read them.", c: "#8b5cf6", icon: I.lock },
  { h: "Just you", p: "DMs and the meetings you hold are private to you, unless you choose to share.", c: "#f472b6", icon: I.user },
]

export const TRUST_LINES = [
  { id: "t1", who: "Ana", t: "Okay, the advertisements are handled by Parag." },
  { id: "t2", who: "Bob", t: "We decided to launch on Friday." },
  { id: "t3", who: "Ana", t: "Bob will send the deck to finance by Thursday." },
  { id: "t4", who: "Parag", t: "Should we connect calendars? Not sure yet." },
]
export const CLAIMS = [
  { ttl: "Parag handles the advertisements", ok: true, line: "t1", res: "Quote found: “handled by Parag”" },
  { ttl: "Launch on Friday", ok: true, line: "t2", res: "Quote found: “decided to launch on Friday”" },
  { ttl: "Build the frontend AI integration", ok: false, line: "", res: "No quote in the meeting. Dropped." },
  { ttl: "Bob sends the deck by Thursday", ok: true, line: "t3", res: "Quote found: “send the deck… by Thursday”" },
  { ttl: "Adopt GraphQL everywhere", ok: false, line: "", res: "No quote in the meeting. Dropped." },
]

export const FEATURES: { w?: string; icon: ReactNode; c: string; h: string; p: string; tags: string[] }[] = [
  { w: "w8", icon: I.caption(), c: "#2dd4bf", h: "Live captions, in the tools you already use", p: "A browser side panel reads the captions your meeting already shows: Google Meet, Microsoft Teams, Zoom web and Slack Huddles. It follows who is speaking, survives the recognizer rewriting its words, and keeps one clean line per utterance.", tags: ["Google Meet", "Teams", "Zoom (web)", "Slack Huddles", "No bots", "No audio"] },
  { icon: I.check(), c: "#4ade80", h: "Notes that never make things up", p: "Decisions and tasks come from the whole transcript, and each one must carry a verified quote. If it was not said, it is not saved.", tags: ["Quote-checked", "You approve"] },
  { icon: I.chat(), c: "#8b5cf6", h: "Ask the team's memory", p: "Questions about this call or last month's thread get answers with sources you can open, including who is asking and what they said.", tags: ["Sources", "Slack + Brain"] },
  { w: "w8", icon: I.people(), c: "#f472b6", h: "Suggest the right owner", p: "For every task, the best-placed people with the evidence: similar work they have done, what they must finish before the deadline, and time off mentioned in memory.", tags: ["Skills", "Deadlines", "Evidence"] },
  { w: "w8", icon: I.bolt(), c: "#fbbf24", h: "A manager that follows up", p: "Commitments from chat and meetings are tracked, due dates are chased with limits, and opt-in standups and risk scans surface what is slipping.", tags: ["Nudges", "Standups", "Risks"] },
  { icon: I.lock(), c: "#22d3ee", h: "Private by scope", p: "Public, private channel or personal: memory and tasks respect the same boundary they were written in.", tags: ["Shared", "Private", "Personal"] },
  { w: "w6", icon: I.server(), c: "#2dd4bf", h: "Self-hosted", p: "Runs on your infrastructure with Bun, Hono and Postgres (pgvector). No third-party memory service.", tags: ["Bun", "Postgres", "pgvector"] },
  { w: "w6", icon: I.export(), c: "#8b5cf6", h: "Take it anywhere", p: "Export tasks to CSV, JSON, Markdown or calendar files, or push them to Trello and GitHub Issues.", tags: ["CSV", "ICS", "Trello", "GitHub"] },
]

export const MARQUEE = ["Slack Huddles", "Google Meet", "Microsoft Teams", "Zoom", "Notion", "Google Drive", "OneDrive", "GitHub", "Jira", "Trello"]
