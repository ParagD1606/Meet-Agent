import { useEffect, useState, type ReactNode } from "react"
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
    {!open && <path className="ck" d="M7 12.5l3.2 3.2L17 8.5" fill="none" stroke="#16a34a" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
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
      <div className="hw-bar"><i /><i /><i /><span className="url"><MeetLogo size={14} /> meet.google.com/abc-defg-hij</span><span className="ext"><Brain size={13} color="#fff" /></span></div>
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
          <div className="sh"><span className="logo"><Brain size={14} color="#fff" /></span><div><b>Google Meet · Q4 launch sync</b><small><i className="live" /> live · <span className="cnt">0</span> lines</small></div></div>
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

const CHIPS = [
  { y: 226, c: "#E01E5A", t: "slack: #launch-plan · decided Friday" },
  { y: 263, c: "#00ac47", t: "meet: Ana · ads go to Parag" },
  { y: 300, c: "#7B83EB", t: "teams: weekly standup" },
  { y: 337, c: "#e8e6df", t: "notion: Launch plan updated" },
  { y: 374, c: "#4285F4", t: "drive: Q4 deck synced" },
]
const TICKER = [
  ["REMEMBERED", "AWS until December"], ["DECISION", "launch on Friday"], ["TASK", "advertisements → Parag"],
  ["ANSWERED", "“what did we decide?” · 2 sources"], ["FOLLOW-UP", "reminder sent to Parag"],
]
const CARDS = [
  { id: "tl", n: "01", h: "CONVERSATIONS", items: ["Slack threads", "Huddles", "Meet and Teams", "Zoom (web)"], x: 4, y: 1 },
  { id: "tr", n: "04", h: "TEAMMATE", items: ["Answers", "Tasks", "Reminders", "Owner suggestions"], x: 76, y: 3 },
  { id: "bl", n: "02", h: "KNOWLEDGE", items: ["Notion", "Google Drive", "Uploads", "GitHub"], x: 3, y: 73 },
  { id: "br", n: "03", h: "MEMORY", items: ["Shared", "Private channels", "Just you", "Sources"], x: 77, y: 72 },
]
const pct = (v: number, of: number) => `${(v / of) * 100}%`

/** The hero diagram: meeting events flow into the Brain, which writes notes and remembers them. */
export function BrainField() {
  const tiles = [{ x: 478, C: <SlackLogo size={28} /> }, { x: 556, C: <MeetLogo size={30} /> }, { x: 634, C: <TeamsLogo size={32} /> }, { x: 712, C: <NotionLogo size={30} /> }]
  return (
    <div className="field" aria-label="Slack threads, meetings and documents flow into Company Brain, which remembers them and acts on them">
      <div className="fglow" aria-hidden />
      <svg className="fsvg" viewBox="0 0 1180 560" aria-hidden>
        <g className="rings">
          <circle cx="590" cy="300" r="118" /><circle cx="590" cy="300" r="170" strokeDasharray="3 9" className="spin" /><circle cx="590" cy="300" r="232" />
        </g>
        {[[230, 226], [250, 263], [270, 300], [250, 337], [230, 374]].map(([x, y], i) => <path key={i} className="fline" d={`M${x},${y} C${x + 150},${y} 430,${300 + (y - 300) * 0.35} 482,${300 + (y - 300) * 0.35}`} />)}
        <path className="fline" d="M590,64 L590,178" /><path className="fline" d="M590,422 L590,452" />
        {tiles.map((t, i) => <path key={i} className="fline" d={`M590,424 C590,470 ${t.x + 26},448 ${t.x + 26},478`} />)}
      </svg>
      <div className="core" style={{ left: pct(590, 1180), top: pct(300, 560) }}>
        <span className="ctag">COMPANY</span><Brain size={40} color="#1c1c1e" /><span className="cname">Brain</span>
      </div>
      <span className="spoke" style={{ left: pct(590, 1180), top: pct(30, 560), transform: "translateX(-50%)" }}>ALWAYS-SOURCED<i>{I("tick", 14, 2.8)}</i></span>
      <span className="spoke" style={{ right: pct(1180 - 462, 1180), top: pct(290, 560) }}>CAPTURING</span>
      <span className="spoke" style={{ left: pct(716, 1180), top: pct(290, 560) }}>MEMORY</span>
      {CHIPS.map((c) => <span key={c.t} className="chip" style={{ top: pct(c.y - 13, 560), left: 0 }}><i style={{ background: c.c }} />{c.t}</span>)}
      <div className="ticker" style={{ left: pct(790, 1180), top: pct(290, 560) }}>
        <div className="ttrack">{[...TICKER, ...TICKER].map(([k, v], i) => <span key={i}><b>[ {k} ]</b> {v}<em>▸</em></span>)}</div>
      </div>
      {CARDS.map((c) => (
        <div key={c.id} className="fcard" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
          <div className="fh"><i>{c.n}</i>{c.h}</div>
          {c.items.map((x) => <div className="fi" key={x}><u />{x}</div>)}
        </div>
      ))}
      {tiles.map((t, i) => <div key={i} className="ftile" style={{ left: pct(t.x, 1180), top: pct(480, 560) }}><Tile size={52}>{t.C}</Tile></div>)}
    </div>
  )
}

export const PLATFORMS = [
  { n: "SLACK", L: <SlackLogo size={16} /> }, { n: "GOOGLE MEET", L: <MeetLogo size={17} /> }, { n: "MICROSOFT TEAMS", L: <TeamsLogo size={18} /> },
  { n: "ZOOM", L: <ZoomLogo size={18} /> }, { n: "NOTION", L: <NotionLogo size={16} /> },
]

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
          <svg className="tick" width="30" height="30" viewBox="0 0 30 30" aria-hidden><circle cx="15" cy="15" r="13" fill="#16a34a" /><path d="M8.5 15.5l4.2 4.2 8.3-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (<>
          <svg className="scrib" viewBox="0 0 220 130" preserveAspectRatio="none" aria-hidden><path d="M8,26 L208,18 L10,52 L210,46 L12,80 L208,74 L16,108 L204,100" fill="none" stroke="#dc2626" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>
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
    <div className="toast"><span className="ti"><Brain size={15} color="#fff" /></span><div><b>Remembered</b><span>Launch is Friday, ads go to Parag</span></div></div>
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
  { q: "Is it just a meeting note-taker?", a: "No. Meetings are one source. Company Brain remembers Slack conversations, documents you sync and tasks as well, and answers questions across all of it, with sources." },
  { q: "Does it join my meetings?", a: "No. In meetings it reads the captions your meeting already shows, from a side panel in your browser. No bot joins the call and no audio is recorded." },
  { q: "Which tools does it work with?", a: "Slack is the home base. Google Meet works today; Microsoft Teams, Zoom (in the browser) and Slack Huddles in the browser are supported too, but are newer. It also syncs Notion, Google Drive and OneDrive, and connects to tools like GitHub, Jira and Trello." },
  { q: "Can it make things up?", a: "Answers come with their sources. In meetings, every decision and task has to quote words that were really said, or it is dropped. Nothing is saved until you approve it." },
  { q: "Who can see what it remembers?", a: "Only what they could already see. Public channels are shared with the workspace, private channels stay with their members, and your DMs and meetings are yours." },
  { q: "Where does my data live?", a: "On your own server. Company Brain is self-hosted on Bun, Hono and Postgres, with no third-party memory service." },
  { q: "How do I start?", a: "Sign in with the Slack workspace this deployment belongs to. To add meetings, press “Get my token” on the Meetings page, paste it into the browser extension, and open your next call." },
]

export { APPS }

const ROLES = [
  { k: "Founder", d: "Remembers every decision", ch: "#leadership", msgs: [["Ana", "Did we ever settle the AWS vs GCP question?"], ["Raj", "No idea, that was in a call weeks ago."]], ask: "what did we decide about hosting?", ans: "Staying on AWS until December, then revisit. Decided in the 14 Oct call and confirmed in #infra.", src: ["meet: Infra sync", "slack: #infra"] },
  { k: "Eng lead", d: "Knows why things were built", ch: "#eng", msgs: [["Sam", "Why do we retry uploads three times?"], ["Priya", "Was a fix for flaky Meet captions I think?"]], ask: "why do uploads retry 3 times?", ans: "A retry queue was added after captions failed to upload on bad networks. It's in the PR thread from September.", src: ["slack: #eng thread", "github: PR notes"] },
  { k: "Head of ops", d: "Keeps follow-ups from slipping", ch: "#ops", msgs: [["Mia", "Who owns the vendor renewal?"], ["Jo", "Parag said he'd take it, due Friday."]], ask: "open tasks for Parag this week", ans: "2 open: vendor renewal (due Fri) and advertisements. A reminder goes out Thursday.", src: ["meet: Weekly standup", "slack: #ops"] },
  { k: "New hire", d: "Gets up to speed alone", ch: "DM with Brain", msgs: [["You", "Just joined. What is the launch plan?"]], ask: "summarise the launch plan", ans: "Launch on Friday. Ads go to Parag, docs to Ana. Only from channels you can see.", src: ["slack: #launch-plan", "notion: Launch plan"] },
]
export function RoleStories() {
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const t = setInterval(() => setI((x) => (x + 1) % ROLES.length), 6500)
    return () => clearInterval(t)
  }, [paused])
  const r = ROLES[i]!
  return (
    <div className="roles" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="rtabs" role="tablist" aria-label="Choose a role">
        {ROLES.map((x, n) => (
          <button key={x.k} type="button" role="tab" aria-selected={n === i} className={n === i ? "on" : ""} onClick={() => setI(n)}>
            <b>{x.k}</b><span>{x.d}</span>{n === i && !paused && <i className="rbar" key={i} />}
          </button>
        ))}
      </div>
      <div className="rstage" key={i}>
        <div className="rhead"><SlackLogo size={16} />{r.ch}</div>
        {r.msgs.map((m, n) => <div className="rmsg" style={{ animationDelay: `${n * 0.25}s` }} key={n}><i>{m[0]![0]}</i><div><b>{m[0]}</b><p>{m[1]}</p></div></div>)}
        <div className="rmsg" style={{ animationDelay: `${r.msgs.length * 0.25}s` }}><i className="br"><Brain size={13} color="#fff" /></i><div><b>@Brain <em>{r.ask}</em></b><p className="rans">{r.ans}</p><div className="rsrc">{r.src.map((x) => <span key={x}>{x}</span>)}</div></div></div>
      </div>
    </div>
  )
}
