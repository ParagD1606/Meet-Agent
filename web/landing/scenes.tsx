import type { ReactNode } from "react"
import { APPS, DriveLogo, GitHubLogo, JiraLogo, MeetLogo, NotionLogo, SlackLogo, TeamsLogo, Tile, TrelloLogo, ZoomLogo } from "./logos"

const AV: Record<string, string> = { Ana: "#e0703a", Bob: "#3b82f6", Parag: "#8b5cf6", You: "#14b8a6", Maya: "#ec4899" }
export const Av = ({ n, size = 24 }: { n: string; size?: number }) => <span className="av" style={{ background: AV[n] ?? "#64748b", width: size, height: size, fontSize: size * 0.43 }}>{n[0]}</span>

export const Brain = ({ size = 16, color = "#fff" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5 4 4 0 0 0 8 0 3 3 0 0 0 2-5 3 3 0 0 0-2-5V7a4 4 0 0 0-4-4z" /><path d="M12 3v18" />
  </svg>
)
const Check = ({ open = false, size = 22 }: { open?: boolean; size?: number }) => (
  <svg className="cb" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={open ? "3 3" : undefined} opacity={open ? 0.6 : 0.9} />
    {!open && <path className="ck" d="M7 12.5l3.2 3.2L17 8.5" fill="none" stroke="#3ddc84" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>
)
const Svg = ({ d, size = 20, sw = 1.8 }: { d: string[]; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d.map((p, i) => <path key={i} d={p} />)}</svg>
)
export const ICON = {
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"],
  lock: ["M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z", "M8 11V8a4 4 0 0 1 8 0v3"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  tick: ["M5 12.5l4.5 4.5L19 7"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
}
export const I = (k: keyof typeof ICON, size = 20, sw = 1.8) => <Svg d={ICON[k]} size={size} sw={sw} />

/** The product, at a glance: a Meet call on the left, the side panel reading it on the right. */
export function HeroWindow() {
  const tiles = [{ n: "Ana", bg: "#e0703a" }, { n: "Bob", bg: "#3b82f6" }, { n: "You", bg: "#14b8a6" }, { n: "Maya", bg: "#ec4899" }]
  const lines = [
    { who: "Ana", say: "We decided to launch on Friday.", spk: 0 },
    { who: "Ana", say: "The advertisements are handled by Parag.", spk: 0 },
    { who: "Bob", say: "I'll write the user guide by Thursday.", spk: 1 },
  ]
  return (
    <div className="hw">
      <div className="hw-bar"><i /><i /><i /><span className="url"><MeetLogo size={14} /> meet.google.com/abc-defg-hij</span><span className="ext"><Brain size={13} color="#0b0b0c" /></span></div>
      <div className="hw-body">
        <div className="call">
          <div className="grid">
            {tiles.map((t, i) => (
              <div className="vt" key={t.n}><span className="vav" style={{ background: t.bg }}>{t.n[0]}</span><span className="tag">{t.n}</span><i className="ring" data-i={i} /></div>
            ))}
          </div>
          <div className="caps">
            {lines.map((l, i) => <div className="capline" key={i}><Av n={l.who} size={28} /><div><b>{l.who}</b><span className="ct">{l.say}</span></div></div>)}
          </div>
          <div className="tools"><i /><i /><i className="cc">CC</i><i /><i className="end" /></div>
        </div>
        <div className="side">
          <div className="sh"><span className="logo"><Brain size={14} color="#0b0b0c" /></span><div><b>Google Meet · Q4 launch sync</b><small><i className="live" /> live · <span className="cnt">0</span> lines</small></div></div>
          <div className="stabs"><span className="on" data-t="live">Live</span><span>Notes</span><span data-t="items">Items<em>3</em></span><span>Suggest</span><span>Ask</span></div>
          <div className="sbody">
            <div className="pview vlive">
              {lines.map((l, i) => <div className="pl" key={i}><Av n={l.who} size={22} /><div><b>{l.who}</b><span>{l.say}</span></div></div>)}
            </div>
            <div className="pview vitems">
              <div className="ic"><Check /><div><b>Decision</b><span>Launch on Friday</span></div></div>
              <div className="ic"><Check /><div><b>Task · Parag</b><span>Handle the advertisements</span></div></div>
              <div className="ic"><Check /><div><b>Task · Bob</b><span>Write the user guide</span></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Four meeting apps feed one set of notes: tiles bob, lines draw, dots travel, the notes write themselves. */
export function HeroScene() {
  const tiles = [
    { id: "meet", cx: 80, cy: 70, C: <MeetLogo size={50} />, dot: "#00ac47" },
    { id: "teams", cx: 150, cy: 190, C: <TeamsLogo size={54} />, dot: "#7B83EB" },
    { id: "zoom", cx: 70, cy: 320, C: <ZoomLogo size={56} />, dot: "#3b82f6" },
    { id: "slack", cx: 150, cy: 450, C: <SlackLogo size={46} />, dot: "#E01E5A" },
  ]
  const ends = [110, 200, 290, 380]
  const d = (t: (typeof tiles)[number], i: number) => `M${t.cx + 42},${t.cy} C${t.cx + 130},${t.cy} ${258 - 90},${ends[i]} 258,${ends[i]}`
  return (
    <div className="scene" aria-label="Meetings in Google Meet, Teams, Zoom and Slack turn into notes">
      <svg className="paths" viewBox="0 0 600 560" aria-hidden>
        {tiles.map((t, i) => <path key={t.id} className="path" d={d(t, i)} />)}
        <g className="flowg">{tiles.map((t) => <circle key={t.id} className="dot" r="5.5" fill={t.dot} />)}</g>
      </svg>
      {tiles.map((t) => (
        <div key={t.id} className="tilepos" style={{ left: `${((t.cx - 42) / 600) * 100}%`, top: `${((t.cy - 42) / 560) * 100}%` }}><Tile size={84} className="bob">{t.C}</Tile></div>
      ))}
      <div className="note">
        <i className="tape" />
        <div className="nhead"><span>Q4 launch sync</span><Tile size={28}><MeetLogo size={17} /></Tile></div>
        <div className="lab">What was said</div>
        <div className="tline"><b>Ana:</b> We decided to launch on Friday.</div>
        <div className="tline"><b>Ana:</b> The advertisements are handled by Parag.</div>
        <div className="tline"><b>Bob:</b> I'll write the user guide by Thursday.</div>
        <div className="lab">Written down</div>
        <div className="rows">
          <div className="row"><Check /><span>Decision: launch on Friday</span></div>
          <div className="row"><Check /><span>Handle the advertisements</span><span className="who"><Av n="Parag" size={20} />Parag</span></div>
          <div className="row"><Check /><span>Write the user guide</span><span className="who"><Av n="Bob" size={20} />Bob</span></div>
        </div>
      </div>
    </div>
  )
}

export const MiniMeet = () => (
  <div className="mock m1">
    <div className="mwin"><MeetLogo size={22} /> Q4 launch sync <span className="cc">CC</span></div>
    <div className="cap"><Av n="Ana" size={28} /><div><b>Ana</b><span className="ty">We decided to launch on Friday.</span></div></div>
    <div className="cap"><Av n="Bob" size={28} /><div><b>Bob</b><span className="ty">I'll write the user guide by Thursday.</span></div></div>
    <div className="cap"><Av n="Parag" size={28} /><div><b>Parag</b><span className="ty">Yes, I will handle the ads.</span></div></div>
  </div>
)
export const MiniChecklist = () => (
  <div className="mock m2">
    <div className="rows" style={{ gap: 16 }}>
      <div className="row"><Check /><span>Launch on Friday</span><span className="who">Decision</span></div>
      <div className="row"><Check /><span>Handle the advertisements</span><span className="who"><Av n="Parag" size={22} />Parag</span></div>
      <div className="row"><Check /><span>Write the user guide</span><span className="who"><Av n="Bob" size={22} />Bob</span></div>
      <div className="row"><Check open /><span>Which browser do users have?</span><span className="who">Question</span></div>
    </div>
  </div>
)
export const MiniSuggest = () => (
  <div className="mock m3">
    <div style={{ fontWeight: 700, fontSize: 15 }}>Update the guide <span className="mono" style={{ fontSize: 11.5, color: "var(--mut)", marginLeft: 8 }}>due Fri</span></div>
    <div className="cand"><Av n="Ana" size={34} /><div><div className="nm">Ana</div><div className="why">Wrote the last two guides</div><span className="pill">Free this week</span></div><button type="button" className="assign">Assign</button></div>
    <div className="cand dim"><Av n="Bob" size={34} /><div><div className="nm">Bob</div><div className="why">No similar work found</div></div></div>
  </div>
)

const NOTES = [
  { text: "Parag handles the ads", q: "“handled by Parag”", ok: true, x: 0, y: 2, r: -3 },
  { text: "Launch on Friday", q: "“decided to launch on Friday”", ok: true, x: 34, y: 0, r: 2 },
  { text: "Build the AI integration", q: "nobody said this", ok: false, x: 68, y: 4, r: -2 },
  { text: "Bob writes the guide by Thursday", q: "“I'll write the user guide”", ok: true, x: 6, y: 50, r: 2.5 },
  { text: "Switch everything to GraphQL", q: "nobody said this", ok: false, x: 40, y: 52, r: -3.5 },
]
export const Board = () => (
  <div className="board">
    {NOTES.map((n) => (
      <div key={n.text} className={`sticky ${n.ok ? "ok" : "no"}`} data-r={n.r} style={{ left: `${n.x}%`, top: `${n.y}%`, transform: `rotate(${n.r}deg)` }}>
        {n.text}<span className="q">{n.q}</span>
        {n.ok ? (
          <svg className="tick" width="30" height="30" viewBox="0 0 30 30" aria-hidden><circle cx="15" cy="15" r="13" fill="#1e9e5a" /><path d="M8.5 15.5l4.2 4.2 8.3-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (<>
          <svg className="scrib" viewBox="0 0 220 130" preserveAspectRatio="none" aria-hidden><path d="M8,26 L208,18 L10,52 L210,46 L12,80 L208,74 L16,108 L204,100" fill="none" stroke="#e5484d" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>
          <span className="stamp">NOT SAID</span>
        </>)}
      </div>
    ))}
  </div>
)

/* ---- bento mini interfaces ---- */
export const BentoAsk = () => (
  <div className="mock chat">
    <div className="msg"><Av n="Parag" size={28} /><div className="t"><b>Parag</b><span className="q1">What did we decide about the deployment?</span></div></div>
    <div className="msg"><span className="bot"><Brain size={16} /></span><div className="t"><b>Company Brain</b><span className="think"><i /><i /><i /></span>
      <span className="a1">You decided on Oct 15 to keep it on AWS and not to change provider before December.</span>
      <div className="src"><span>Huddle notes · Oct 15</span><span># launch-plan</span></div></div></div>
  </div>
)
export const BentoToasts = () => (
  <div className="toasts">
    <div className="toast"><span className="ti"><Brain size={15} color="#0b0b0c" /></span><div><b>Remembered</b><span>Launch is Friday, ads go to Parag</span></div></div>
    <div className="toast"><span className="ti g">{I("tick", 15, 2.6)}</span><div><b>Saved to Meeting notes</b><span>2 tasks, 1 decision</span></div></div>
    <div className="toast"><span className="ti y">!</span><div><b>Reminder for Parag</b><span>“Handle the advertisements” is due tomorrow</span><em><u>Done</u><u>Drop</u></em></div></div>
  </div>
)
export const BentoOwners = () => (
  <div className="mock owners">
    {["Ana", "Bob", "Maya"].map((n, i) => (
      <div className="orow" key={n}><Av n={n} size={30} /><div><b>{n}</b><span>{["Free this week", "3 due before Friday", "Did similar work"][i]}</span></div><i className="pick" /></div>
    ))}
  </div>
)
export const BentoTools = () => (
  <div className="tools3">
    {[<NotionLogo size={30} key="n" />, <DriveLogo size={30} key="d" />, <GitHubLogo size={30} key="g" />, <JiraLogo size={28} key="j" />, <TrelloLogo size={28} key="t" />, <SlackLogo size={28} key="s" />].map((l, i) => <Tile key={i} size={64} className="wig">{l}</Tile>)}
  </div>
)
export const BentoExport = () => (
  <div className="mock exp">
    {["CSV", "Calendar (.ics)", "Markdown", "Trello", "GitHub Issues"].map((x) => <div className="erow" key={x}><span>{x}</span><i>{I("arrow", 15, 2)}</i></div>)}
  </div>
)

export const PRIVACY = [
  { h: "Public channels", p: "Shared with everyone in the workspace.", k: "globe" as const },
  { h: "Private channels", p: "Only the people who are in the channel.", k: "lock" as const },
  { h: "Your DMs and meetings", p: "Only you, unless you choose to share.", k: "user" as const },
]

export const LOG: { t: string; text: string; s: "ok" | "warn" | "no" }[] = [
  { t: "11:02:14", text: "Read 24 caption lines from Google Meet", s: "ok" },
  { t: "11:02:15", text: "Checked 5 proposed items against the transcript", s: "ok" },
  { t: "11:02:15", text: "Dropped “Build the AI integration”: nobody said it", s: "no" },
  { t: "11:02:16", text: "Dropped “Switch everything to GraphQL”: nobody said it", s: "no" },
  { t: "11:02:18", text: "Waiting for you to approve 3 items", s: "warn" },
  { t: "11:02:31", text: "Saved 3 items to Meeting notes", s: "ok" },
]
export const ActivityLog = () => (
  <div className="log" aria-label="Example activity">
    <div className="lh"><span>Example activity</span><i className="live" /></div>
    {LOG.map((l, i) => (
      <div className={`lrow ${l.s}`} key={i}>
        <span className="lic">{l.s === "ok" ? I("tick", 14, 2.8) : l.s === "no" ? <Svg d={["M6 6l12 12", "M18 6L6 18"]} size={14} sw={2.8} /> : <b>!</b>}</span>
        <span className="lt">{l.text}</span><span className="ts mono">{l.t}</span>
      </div>
    ))}
  </div>
)

export const FAQ: { q: string; a: ReactNode }[] = [
  { q: "Does it join my meeting?", a: "No. It reads the captions your meeting already shows, from a side panel in your browser. No bot joins the call and no audio is recorded." },
  { q: "Which meeting tools does it work with?", a: "Google Meet works today. Microsoft Teams, Zoom (in the browser) and Slack Huddles in the browser are supported too, but are newer. Slack Huddles that have AI notes turned on are also picked up on the server." },
  { q: "Can it make things up?", a: "Every decision and task has to quote words that were really said in the meeting. If it can't point to them, the item is dropped. Nothing is saved until you approve it." },
  { q: "Who can see my meetings?", a: "You, and workspace admins. A meeting you upload from the extension is private to you unless you choose to share it." },
  { q: "Where does my data live?", a: "On your own server. Company Brain is self-hosted on Bun, Hono and Postgres, with no third-party memory service." },
  { q: "How do I start?", a: "Sign in with the Slack workspace this deployment belongs to. On the Meetings page, press “Get my token”, paste it into the browser extension, and open your next meeting." },
]

export { APPS }
