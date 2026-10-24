import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { ScrollToPlugin } from "gsap/ScrollToPlugin"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"
import { MotionPathPlugin } from "gsap/MotionPathPlugin"
import { useLayoutEffect, useRef } from "react"
import { APPS, MeetLogo, SlackLogo, TeamsLogo, Tile, ZoomLogo } from "./logos"
import { ActivityLog, BentoAsk, BentoExport, BentoOwners, BentoTools, BentoToasts, Board, BrainField, Brain, FAQ, HeroWindow, I, MiniChecklist, MiniMeet, MiniSuggest, PLATFORMS, PRIVACY } from "./scenes"
import { css } from "./styles"

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, DrawSVGPlugin, MotionPathPlugin)

const Roll = ({ children }: { children: string }) => <span className="roll"><span>{children}</span><span aria-hidden>{children}</span></span>

export default function Landing({ signedIn = false }: { signedIn?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const go = signedIn ? "/" : "/signin"
  const goLabel = signedIn ? "Open your Brain" : "Sign in with Slack"

  useLayoutEffect(() => {
    const el = root.current!
    const off: (() => void)[] = []
    const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = el) => from.querySelector<T>(sel)
    const $$ = <T extends Element = HTMLElement>(sel: string, from: Element = el) => gsap.utils.toArray<T>(sel, from)

    // ---- always on: smooth in-page links, the nav border, and the FAQ (which must work with or without motion)
    const links = $$<HTMLAnchorElement>('a[href^="#"]')
    const onLink = (e: Event) => {
      const a = e.currentTarget as HTMLAnchorElement, t = el.querySelector(a.getAttribute("href")!)
      if (!t) return
      e.preventDefault()
      gsap.to(window, { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1.1, scrollTo: { y: t as HTMLElement, offsetY: 70 }, ease: "power3.inOut" })
    }
    links.forEach((a) => a.addEventListener("click", onLink)); off.push(() => links.forEach((a) => a.removeEventListener("click", onLink)))
    const nav = $(".nav")!
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8)
    onScroll(); window.addEventListener("scroll", onScroll, { passive: true }); off.push(() => window.removeEventListener("scroll", onScroll))
    const qas = $$(".qa")
    qas.forEach((qa) => {
      const btn = qa.querySelector<HTMLButtonElement>(".q")!, ans = qa.querySelector<HTMLElement>(".a")!
      const click = () => {
        const open = !qa.classList.contains("open")
        qas.forEach((o) => { if (o !== qa && o.classList.contains("open")) { o.classList.remove("open"); gsap.to(o.querySelector(".a"), { height: 0, duration: 0.35, ease: "power2.inOut" }) } })
        qa.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open))
        gsap.to(ans, { height: open ? "auto" : 0, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.4, ease: "power2.inOut" })
      }
      btn.addEventListener("click", click); off.push(() => btn.removeEventListener("click", click))
    })
    void document.fonts?.ready.then(() => ScrollTrigger.refresh())

    const mm = gsap.matchMedia(el)
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      // helpers
      const typeIn = (tl: gsap.core.Timeline, node: Element, at: number, dur?: number) => {
        const n = Math.max(6, (node.textContent ?? "").length), d = dur ?? n * 0.035
        tl.fromTo(node, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: d, ease: `steps(${n})` }, at)
        return d
      }
      const whenVisible = (tl: gsap.core.Timeline, trigger: Element, start = "top 88%", end = "bottom 6%") => {
        tl.pause(0)
        ScrollTrigger.create({ trigger, start, end, onToggle: (s) => (s.isActive ? tl.play() : tl.pause()) })
      }

      // ---- hero
      const intro = gsap.timeline({ defaults: { ease: "power3.out" } })
      intro
        .from(".pillb", { y: 18, opacity: 0, duration: 0.7 }, 0)
        .from(".li", { yPercent: 118, duration: 1.1, stagger: 0.12 }, 0.1)
        .fromTo(".squig path", { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.9, ease: "power2.inOut" }, 1.0)
        .from(".hero .bul li", { y: 16, opacity: 0, stagger: 0.08, duration: 0.6 }, 0.6)
        .from(".hero .ctas > *", { y: 20, opacity: 0, stagger: 0.1, duration: 0.7 }, 0.75)
        .from(".hero .fine, .platforms span", { opacity: 0, y: 10, stagger: 0.06, duration: 0.6 }, 1.0)
        .from(".fglow", { opacity: 0, duration: 1.6 }, 0.6)
        .from(".core", { opacity: 0, duration: 1 }, 0.9)
        .from(".rings circle", { opacity: 0, duration: 1.2, stagger: 0.2 }, 0.9)
        .from(".fcard", { opacity: 0, y: 20, stagger: 0.12, duration: 0.8 }, 1.3)
        .from(".ftile", { opacity: 0, y: 24, stagger: 0.1, duration: 0.7, ease: "back.out(1.6)" }, 1.5)
        .from(".spoke, .ticker", { opacity: 0, duration: 0.9 }, 1.6)
      gsap.fromTo(".hw", { rotateX: 12, scale: 0.92 }, { rotateX: 0, scale: 1, ease: "none", scrollTrigger: { trigger: ".hwrap", start: "top 92%", end: "top 30%", scrub: true } })

      // the diagram lives: meeting events flow toward the Brain, notes stream out, the rings turn
      {
        const field = $(".field")!
        $$(".chip", field).forEach((chip, i) => {
          const w = () => chip.offsetWidth, run = () => field.clientWidth * 0.385 - w()
          const tl = gsap.timeline({ repeat: -1, defaults: { ease: "none" } })
          const d = 9 + i * 0.7 // each row has its own pace, so the chips never line up
          tl.fromTo(chip, { x: () => -w() - 20, opacity: 0 }, { x: run, duration: d }, 0)
            .to(chip, { opacity: 1, duration: 1.2 }, 0).to(chip, { opacity: 0, duration: 1.6 }, d - 1.6)
          tl.progress((i * 0.37 + 0.1) % 1)
        })
        gsap.fromTo(".ttrack", { xPercent: -50 }, { xPercent: 0, duration: 34, ease: "none", repeat: -1 })
        gsap.to(".rings .spin", { rotation: 360, svgOrigin: "590 300", duration: 70, ease: "none", repeat: -1 })
        gsap.to(".fglow", { scale: 1.06, opacity: 0.85, duration: 3.2, yoyo: true, repeat: -1, ease: "sine.inOut" })
        const cards = $$(".fcard", field), hot = gsap.timeline({ repeat: -1 })
        cards.forEach((c, i) => hot.call(() => { cards.forEach((o) => o.classList.remove("hot")); c.classList.add("hot") }, undefined, i * 1.7))
        hot.to({}, { duration: cards.length * 1.7 })
      }

      // the product preview plays a short meeting, then the panel turns it into notes
      {
        const hw = $(".hw")!, caps = $$(".capline", hw), pls = $$(".pl", hw), cards = $$(".ic", hw), rings = $$(".ring", hw), tabs = $$(".stabs span", hw)
        const live = $(".pview.vlive", hw)!, items = $(".pview.vitems", hw)!, cnt = $(".cnt", hw)!, who = [0, 0, 1]
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.4 })
        tl.set(caps, { opacity: 0 }, 0).set(pls, { opacity: 0, y: 10 }, 0).set(cards, { opacity: 0, y: 14 }, 0).set(items, { opacity: 0 }, 0).set(live, { opacity: 1 }, 0).set(rings, { opacity: 0 }, 0)
          .call(() => { cnt.textContent = "0"; tabs[0]!.classList.add("on"); tabs[2]!.classList.remove("on") }, undefined, 0)
        caps.forEach((c, i) => {
          const at = 0.8 + i * 3
          tl.set(c, { opacity: 1 }, at)
          typeIn(tl, c.querySelector(".ct")!, at + 0.1, 1.5)
          tl.to(rings[who[i]!]!, { opacity: 1, duration: 0.2 }, at).to(rings[who[i]!]!, { opacity: 0, duration: 0.3 }, at + 2.3)
            .to(pls[i]!, { opacity: 1, y: 0, duration: 0.4 }, at + 0.5).call(() => { cnt.textContent = String((i + 1) * 8) }, undefined, at + 0.5)
            .to(c, { opacity: 0, duration: 0.3 }, at + 2.5)
        })
        const t2 = 0.8 + caps.length * 3
        tl.call(() => { tabs[0]!.classList.remove("on"); tabs[2]!.classList.add("on") }, undefined, t2)
          .to(live, { opacity: 0, duration: 0.3 }, t2).to(items, { opacity: 1, duration: 0.3 }, t2 + 0.1)
        cards.forEach((c, i) => tl.to(c, { opacity: 1, y: 0, duration: 0.45, ease: "back.out(1.6)" }, t2 + 0.4 + i * 0.4).fromTo(c.querySelector(".ck"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.4 }, t2 + 0.75 + i * 0.4))
        tl.to({}, { duration: 3 })
        whenVisible(tl, hw, "top 95%", "bottom 5%")
      }

      // ---- logo rows scrolling in opposite directions
      const rows = $$(".mrow")
      gsap.to(rows[0]!, { xPercent: -50, duration: 48, ease: "none", repeat: -1 })
      gsap.fromTo(rows[1]!, { xPercent: -50 }, { xPercent: 0, duration: 56, ease: "none", repeat: -1 })

      // ---- the three feature rows
      gsap.set(".frow .ftxt > *", { opacity: 0, y: 30 })
      $$(".frow").forEach((row) => ScrollTrigger.create({ trigger: row, start: "top 82%", once: true, onEnter: () => {
        gsap.to($$(".ftxt > *", row), { opacity: 1, y: 0, stagger: 0.1, duration: 0.8, ease: "power3.out" })
        gsap.from($(".mock", row), { y: 60, opacity: 0, scale: 0.96, duration: 1, ease: "power3.out" })
      } }))
      {
        const m = $(".m1")!, caps = $$(".cap", m), tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6 })
        tl.set(caps, { opacity: 0, y: 12 }, 0)
        caps.forEach((c, i) => { tl.to(c, { opacity: 1, y: 0, duration: 0.35 }, 0.3 + i * 1.9); typeIn(tl, c.querySelector(".ty")!, 0.45 + i * 1.9, 1.3) })
        tl.to({}, { duration: 2 }).to(caps, { opacity: 0, duration: 0.4 })
        gsap.to($(".cc", m), { scale: 1.2, duration: 0.7, yoyo: true, repeat: -1, ease: "sine.inOut" })
        whenVisible(tl, m)
      }
      {
        const m = $(".m2")!, rws = $$(".row", m), tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6 })
        tl.set(rws, { opacity: 0, x: -16 }, 0).set($$(".ck", m), { drawSVG: "0%" }, 0)
        rws.forEach((r, i) => { tl.to(r, { opacity: 1, x: 0, duration: 0.4 }, 0.3 + i * 0.9); const ck = r.querySelector(".ck"); if (ck) tl.to(ck, { drawSVG: "100%", duration: 0.4 }, 0.6 + i * 0.9) })
        tl.to({}, { duration: 2.4 }).to(rws, { opacity: 0, duration: 0.4 })
        whenVisible(tl, m)
      }
      {
        const m = $(".m3")!, cands = $$(".cand", m), btn = $(".assign", m)!, tl = gsap.timeline({ repeat: -1, repeatDelay: 1.4 })
        tl.set(cands, { opacity: 0, x: 40 }, 0).call(() => { btn.textContent = "Assign"; btn.classList.remove("done") }, undefined, 0)
          .to(cands[0]!, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, 0.3).to(cands[1]!, { opacity: 0.5, x: 0, duration: 0.5, ease: "power3.out" }, 0.55)
          .to(btn, { scale: 0.88, duration: 0.12 }, 2.2).call(() => { btn.textContent = "Assigned ✓"; btn.classList.add("done") }, undefined, 2.3).to(btn, { scale: 1, duration: 0.25, ease: "back.out(3)" }, 2.32)
          .to({}, { duration: 2.2 }).to(cands, { opacity: 0, duration: 0.4 })
        whenVisible(tl, m)
      }

      // ---- the sticky notes: five proposed items, three survive
      {
        const board = $(".board")!, st = $$(".sticky", board), oks = st.filter((s) => s.classList.contains("ok")), nos = st.filter((s) => s.classList.contains("no"))
        const prop = $(".t-prop")!, keep = $(".t-keep")!, drop = $(".t-drop")!
        const rot = (s: HTMLElement) => Number(s.dataset.r)
        gsap.set(st, { opacity: 0 })
        const tl = gsap.timeline({ paused: true })
        const reset = () => { prop.textContent = keep.textContent = drop.textContent = "0" }
        tl.call(reset, undefined, 0)
        st.forEach((s, i) => tl.fromTo(s, { y: -150, opacity: 0, rotate: rot(s) + gsap.utils.random(-14, 14, 1) }, { y: 0, opacity: 1, rotate: rot(s), duration: 0.85, ease: "back.out(1.5)" }, i * 0.22)
          .call(() => { prop.textContent = String(i + 1) }, undefined, i * 0.22 + 0.4))
        oks.forEach((s, i) => tl.fromTo(s.querySelector(".tick"), { scale: 0, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.4, ease: "back.out(3)" }, 1.9 + i * 0.25)
          .call(() => { keep.textContent = String(i + 1) }, undefined, 1.9 + i * 0.25))
        nos.forEach((s, i) => {
          const at = 2.9 + i * 1.5
          tl.fromTo(s.querySelector(".scrib path"), { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.6, ease: "power1.inOut" }, at)
            .fromTo(s.querySelector(".stamp"), { scale: 2.6, opacity: 0, rotate: -20 }, { scale: 1, opacity: 1, rotate: -8, duration: 0.28, ease: "power4.in" }, at + 0.6)
            .call(() => { drop.textContent = String(i + 1) }, undefined, at + 0.7)
            .to(s, { y: 150, rotate: rot(s) + 16, opacity: 0, duration: 0.8, ease: "power2.in" }, at + 1.2)
        })
        ScrollTrigger.create({ trigger: board, start: "top 70%", once: true, onEnter: () => tl.play() })
        const replay = $(".replay")!, again = () => { tl.restart() }
        replay.addEventListener("click", again); off.push(() => replay.removeEventListener("click", again))
      }

      // ---- bento: every card has its own little loop
      gsap.set(".bc", { opacity: 0, y: 50 })
      ScrollTrigger.batch(".bc", { start: "top 88%", once: true, onEnter: (b) => gsap.to(b, { opacity: 1, y: 0, stagger: 0.1, duration: 0.9, ease: "power3.out" }) })
      {
        const m = $(".bc .chat")!, q = $(".q1", m)!, th = $(".think", m)!, a = $(".a1", m)!, chips = $$(".src span", m), dots = $$("i", th)
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.4 })
        tl.set([q, a], { clipPath: "inset(0 100% 0 0)" }, 0).set(th, { display: "inline-flex" }, 0).set(chips, { opacity: 0, scale: 0.6 }, 0)
        typeIn(tl, q, 0.4, 1.5)
        tl.to(dots, { y: -5, duration: 0.3, yoyo: true, repeat: 3, stagger: 0.1 }, 2.1).set(th, { display: "none" }, 3.4)
        typeIn(tl, a, 3.45, 2.2)
        tl.to(chips, { opacity: 1, scale: 1, stagger: 0.15, duration: 0.35, ease: "back.out(2)" }, 5.8).to({}, { duration: 2.2 })
        whenVisible(tl, m, "top 92%")
      }
      {
        const m = $(".toasts")!, ts = $$(".toast", m), tl = gsap.timeline({ repeat: -1, repeatDelay: 1 })
        tl.set(ts, { opacity: 0, x: 50 }, 0)
        ts.forEach((t, i) => tl.to(t, { opacity: 1, x: 0, duration: 0.5, ease: "back.out(1.5)" }, 0.4 + i * 1.1))
        tl.to({}, { duration: 2.4 }).to(ts, { opacity: 0, x: -30, stagger: 0.08, duration: 0.4 })
        whenVisible(tl, m, "top 92%")
      }
      {
        const m = $(".owners")!, rs = $$(".orow", m), tl = gsap.timeline({ repeat: -1 })
        rs.forEach((r, i) => tl.call(() => { rs.forEach((o) => o.classList.remove("on")); r.classList.add("on") }, undefined, i * 1.4))
        tl.to({}, { duration: rs.length * 1.4 })
        whenVisible(tl, m, "top 92%")
      }
      gsap.to($$(".wig"), { rotate: "random(-9,9)", y: "random(-5,5)", duration: 1.4, yoyo: true, repeat: -1, stagger: 0.15, ease: "sine.inOut" })
      {
        const m = $(".exp")!, rs = $$(".erow", m), tl = gsap.timeline({ repeat: -1 })
        rs.forEach((r, i) => tl.call(() => { rs.forEach((o) => o.classList.remove("on")); r.classList.add("on") }, undefined, i * 1.1))
        tl.to({}, { duration: rs.length * 1.1 })
        whenVisible(tl, m, "top 92%")
      }

      // ---- the activity log fills in like a live feed
      {
        const log = $(".log")!, rws = $$(".lrow", log), tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 })
        tl.set(rws, { opacity: 0, y: 18 }, 0)
        rws.forEach((r, i) => tl.to(r, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, 0.4 + i * 0.85).from(r.querySelector(".lic"), { scale: 0, duration: 0.4, ease: "back.out(3)" }, 0.55 + i * 0.85))
        tl.to({}, { duration: 3 }).to(rws, { opacity: 0, duration: 0.4 })
        whenVisible(tl, log)
      }

      // ---- the rest rises in as you scroll
      gsap.set("[data-reveal]", { opacity: 0, y: 40 })
      ScrollTrigger.batch("[data-reveal]", { start: "top 90%", once: true, onEnter: (b) => gsap.to(b, { opacity: 1, y: 0, stagger: 0.1, duration: 0.9, ease: "power3.out" }) })
      gsap.fromTo(".h1-hl, .big .hl", { "--s": 0 }, { "--s": 1, duration: 0.9, ease: "power3.out", scrollTrigger: { trigger: ".statement", start: "top 75%", once: true } })
      gsap.from(".cta h2", { y: 70, opacity: 0, duration: 1.1, ease: "power3.out", scrollTrigger: { trigger: ".cta", start: "top 75%", once: true } })
      gsap.from(".cta .works .tile", { scale: 0, rotate: -20, stagger: 0.09, ease: "back.out(2.2)", duration: 0.55, scrollTrigger: { trigger: ".cta", start: "top 65%", once: true } })
    })

    return () => { mm.revert(); off.forEach((f) => f()); ScrollTrigger.getAll().forEach((t) => t.kill()) }
  }, [])

  const works = <div className="works"><span>Works in</span>{[<MeetLogo size={26} key="m" />, <TeamsLogo size={28} key="t" />, <ZoomLogo size={30} key="z" />, <SlackLogo size={24} key="s" />].map((l, i) => <Tile key={i} size={44}>{l}</Tile>)}</div>
  const strip = [...APPS, ...APPS]

  return (
    <div className="lp" ref={root}>
      <style>{css}</style>

      <header className="nav"><div className="wrap">
        <a href="#top" className="brand"><i><Brain size={16} color="#111" /></i>Company Brain</a>
        <nav className="links" aria-label="Sections"><a href="#how">How it works</a><a href="#more">What it does</a><a href="#security">Security</a><a href="#faq">FAQ</a></nav>
        <div className="right"><a href={go} className="plain">{signedIn ? "Dashboard" : "Sign in"}</a><a href={go} className="btn pri sm"><Roll>{goLabel}</Roll></a></div>
      </div></header>

      <section className="hero" id="top"><div className="wrap">
        <span className="pillb"><b>New</b>Notes from Meet, Teams, Zoom and Slack</span>
        <h1 className="h1">
          <span className="lm"><span className="li">Meetings that write</span></span>
          <span className="lm"><span className="li">their <span className="own"><span className="it">own</span><svg className="squig" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden><path d="M2,12 C28,2 48,19 78,10 S128,3 158,11 S190,16 198,7" fill="none" stroke="#ffe14d" strokeWidth="5" strokeLinecap="round" /></svg></span> notes.</span></span>
        </h1>
        <ul className="bul"><li>{I("tick", 18, 2.6)}Decisions and tasks with real owners</li><li>{I("tick", 18, 2.6)}Suggests who should take each task</li><li>{I("tick", 18, 2.6)}Never writes what wasn't said</li></ul>
        <div className="ctas"><a href={go} className="btn pri"><SlackLogo size={20} /><Roll>{goLabel}</Roll></a><a href="#how" className="btn ghost"><Roll>See how it works</Roll></a></div>
        <p className="fine">Self-hosted. Your data stays on your own server.</p>
        <div className="platforms">{PLATFORMS.map((p) => <span key={p.n}>{p.L}{p.n}</span>)}<span>CHROME EXTENSION</span></div>
        <BrainField />
      </div></section>

      <section className="strip" aria-label="Works with">
        <p className="tag cap2">Works with the tools your team already uses</p>
        <div className="mrow">{strip.map((a, i) => <span className="mitem" key={i}><Tile size={52}><a.Logo size={30} /></Tile>{a.name}</span>)}</div>
        <div className="mrow">{[...strip].reverse().map((a, i) => <span className="mitem" key={i}><Tile size={52}><a.Logo size={30} /></Tile>{a.name}</span>)}</div>
      </section>

      <section className="sec" style={{ paddingBottom: 40 }}><div className="wrap" style={{ textAlign: "center" }}>
        <p className="tag" data-reveal>In a real meeting</p>
        <h2 className="big" data-reveal style={{ marginTop: 16 }}>Watch a meeting turn into <span className="it">notes</span>.</h2>
        <div className="hwrap"><HeroWindow /></div>
      </div></section>

      <section className="sec" id="how" style={{ paddingTop: 20 }}><div className="wrap">
        <p className="tag" data-reveal>How it works</p>
        <h2 className="big" data-reveal style={{ marginTop: 16, maxWidth: 760 }}>It does the note-taking, so you can <span className="it">talk</span>.</h2>
        <div className="frow"><div className="ftxt"><p className="tag">1 · Listen</p><h3>It reads the captions.</h3><p>Turn on captions in your meeting. A side panel in your browser follows who says what, with real names. No bot joins the call and no audio is recorded.</p><a href={go} className="tlink">Try it on a call {I("arrow", 18, 2)}</a></div><MiniMeet /></div>
        <div className="frow flip"><div className="ftxt"><p className="tag">2 · Write down</p><h3>It writes down what happened.</h3><p>Decisions, tasks and open questions come from the whole meeting, not a guess halfway through. You approve what gets saved.</p><a href={go} className="tlink">See the notes {I("arrow", 18, 2)}</a></div><MiniChecklist /></div>
        <div className="frow"><div className="ftxt"><p className="tag">3 · Assign</p><h3>It finds the right person.</h3><p>It looks at who has done similar work and who has time before the deadline, and shows you the reasons, so assigning is one click.</p><a href={go} className="tlink">Try the suggestions {I("arrow", 18, 2)}</a></div><MiniSuggest /></div>
      </div></section>

      <section className="sec statement"><div className="wrap">
        <p className="tag" data-reveal>The rule</p>
        <h2 className="big" data-reveal style={{ marginTop: 16 }}>If it wasn't said, <span className="hl">it isn't written</span>.</h2>
        <p className="lead" data-reveal style={{ marginInline: "auto" }}>Every decision and task has to quote words that were really said. If it can't, it's thrown away. Watch it happen.</p>
        <Board />
        <div className="tally"><div><b className="t-prop">5</b>proposed</div><div><b className="t-keep" style={{ color: "var(--green)" }}>3</b>kept</div><div><b className="t-drop" style={{ color: "var(--red)" }}>2</b>dropped</div></div>
        <button type="button" className="replay">Replay</button>
      </div></section>

      <section className="sec" id="more" style={{ paddingTop: 20 }}><div className="wrap">
        <p className="tag" data-reveal>And around the meeting</p>
        <h2 className="big" data-reveal style={{ marginTop: 16, maxWidth: 760 }}>It remembers, reminds and <span className="it">connects</span>.</h2>
        <div className="bento">
          <div className="bc c7"><div className="t"><b>Ask your team's memory</b><span>Answers about last week's meeting or last month's thread, with the sources.</span></div><BentoAsk /></div>
          <div className="bc c5"><div className="t"><b>Remembers as you go</b><span>Saves what matters and follows up on due dates.</span></div><BentoToasts /></div>
          <div className="bc c4"><div className="t"><b>Suggests owners</b><span>Skills and deadlines, with the reasons.</span></div><BentoOwners /></div>
          <div className="bc c4"><div className="t"><b>Connects to your tools</b><span>Notion, Drive, GitHub, Jira, Trello and more.</span></div><BentoTools /></div>
          <div className="bc c4"><div className="t"><b>Take it anywhere</b><span>Export tasks, or push them to your board.</span></div><BentoExport /></div>
        </div>
      </div></section>

      <section className="sec" id="security" style={{ paddingTop: 20 }}><div className="wrap sec2">
        <div>
          <p className="tag" data-reveal>Security and privacy</p>
          <h2 className="big" data-reveal style={{ marginTop: 16 }}>Your meetings stay <span className="it">yours</span>.</h2>
          <ul className="checks" data-reveal>
            <li>{I("tick", 20, 2.6)}Self-hosted: it runs on your server, not ours.</li>
            <li>{I("tick", 20, 2.6)}It only reads what you are allowed to read.</li>
            <li>{I("tick", 20, 2.6)}No bot in your calls and no audio recorded.</li>
            <li>{I("tick", 20, 2.6)}Nothing is saved until you approve it.</li>
          </ul>
          <div className="prows" data-reveal>{PRIVACY.map((p) => <div className="prow" key={p.h}><span className="pi">{I(p.k, 20)}</span><div><b>{p.h}</b><span>{p.p}</span></div></div>)}</div>
        </div>
        <ActivityLog />
      </div></section>

      <section className="sec" id="faq" style={{ paddingTop: 20 }}><div className="wrap">
        <p className="tag" data-reveal style={{ textAlign: "center" }}>FAQ</p>
        <h2 className="big" data-reveal style={{ marginTop: 16, textAlign: "center" }}>Questions, answered.</h2>
        <div className="faq" data-reveal>{FAQ.map((f) => <div className="qa" key={f.q}><button type="button" className="q" aria-expanded="false"><span>{f.q}</span><i className="pm" /></button><div className="a"><p>{f.a}</p></div></div>)}</div>
      </div></section>

      <section className="cta"><div className="wrap">
        <h2>Try it on your next <span className="it">meeting</span>.</h2>
        <p>Sign in with the Slack workspace this deployment belongs to.</p>
        <div className="ctas"><a href={go} className="btn pri"><SlackLogo size={20} /><Roll>{goLabel}</Roll></a></div>
        {works}
        {!signedIn && <p style={{ marginTop: 22, fontSize: 14 }}><a href="/setup" style={{ textDecoration: "underline", textUnderlineOffset: 4 }}>Setting up a new deployment?</a></p>}
      </div></section>

      <footer className="foot"><div className="wrap">
        <div className="fgrid">
          <div><a href="#top" className="brand" style={{ color: "var(--fg)" }}><i><Brain size={16} color="#111" /></i>Company Brain</a><p style={{ marginTop: 12, maxWidth: 260 }}>The teammate that remembers what your team says.</p></div>
          <div><b>Product</b><a href="#how">How it works</a><a href="#more">What it does</a><a href="#security">Security</a></div>
          <div><b>Account</b><a href={go}>{goLabel}</a><a href="/setup">Set up a deployment</a></div>
          <div><b>Help</b><a href="#faq">FAQ</a></div>
        </div>
        <p className="legal">Company Brain is self-hosted on Bun, Hono and Postgres (pgvector). Google Meet, Microsoft Teams, Zoom, Slack, Notion, Google Drive, GitHub, Jira and Trello are trademarks of their respective owners; their logos are shown to indicate compatibility.</p>
      </div></footer>
    </div>
  )
}
