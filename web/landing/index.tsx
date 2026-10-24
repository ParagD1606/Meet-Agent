import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { ScrollToPlugin } from "gsap/ScrollToPlugin"
import { SplitText } from "gsap/SplitText"
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin"
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin"
import { useLayoutEffect, useRef } from "react"
import { burst, cursor, magnetic, spotlightTilt } from "./motion"
import { mountNeural } from "./neural"
import { CLAIMS, FEATURES, GRAPH, I, MARQUEE, PanelMock, SCOPES, STEPS, TRUST_LINES } from "./parts"
import { css } from "./styles"

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText, ScrambleTextPlugin, DrawSVGPlugin)

export default function Landing({ signedIn = false }: { signedIn?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const go = signedIn ? "/" : "/signin"
  const goLabel = signedIn ? "Open your Brain" : "Sign in with Slack"

  useLayoutEffect(() => {
    const el = root.current!
    const off: (() => void)[] = []
    const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = el) => from.querySelector<T>(sel)
    const $$ = <T extends Element = HTMLElement>(sel: string, from: Element = el) => gsap.utils.toArray<T>(sel, from)

    // Always on: the canvas (draws one still frame under reduced motion), interaction polish, smooth in-page links.
    off.push(mountNeural($<HTMLCanvasElement>(".neural")!))
    off.push(magnetic(el), spotlightTilt(el), cursor(el))
    const links = $$<HTMLAnchorElement>('a[href^="#"]')
    const onLink = (e: Event) => {
      const a = e.currentTarget as HTMLAnchorElement, t = el.querySelector(a.getAttribute("href")!)
      if (!t) return
      e.preventDefault()
      gsap.to(window, { duration: 1.2, scrollTo: { y: t as HTMLElement, offsetY: 64 }, ease: "power3.inOut" })
    }
    links.forEach((a) => a.addEventListener("click", onLink)); off.push(() => links.forEach((a) => a.removeEventListener("click", onLink)))
    void document.fonts?.ready.then(() => ScrollTrigger.refresh())

    const mm = gsap.matchMedia(el)
    mm.add({ motion: "(prefers-reduced-motion: no-preference)", desktop: "(min-width: 941px)" }, (ctx) => {
      const { motion, desktop } = ctx.conditions as { motion: boolean; desktop: boolean }
      if (!motion) {
        $$(".step").forEach((s) => s.classList.add("on"))
        return
      }

      // ---- progress bar + nav that tucks away while scrolling down
      gsap.to(".progress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.2 } })
      const nav = $(".nav")!
      ScrollTrigger.create({ start: 0, end: "max", onUpdate: (s) => nav.classList.toggle("hide", s.direction === 1 && s.scroll() > 240) })

      // ---- hero intro
      const split = SplitText.create(".h1", { type: "words,chars", wordsClass: "wd", charsClass: "ch" })
      const em = split.chars.filter((c) => c.closest("em")), pal = [[45, 212, 191], [139, 92, 246], [244, 114, 182]]
      em.forEach((node, i) => {
        const c = node as HTMLElement
        const t = em.length > 1 ? i / (em.length - 1) : 0, seg = Math.min(1, t * 2), a = pal[t < 0.5 ? 0 : 1]!, b = pal[t < 0.5 ? 1 : 2]!
        const u = t < 0.5 ? seg : (t - 0.5) * 2
        c.style.color = `rgb(${a.map((v, k) => Math.round(v + (b[k]! - v) * u)).join(",")})`
      })
      const intro = gsap.timeline({ defaults: { ease: "power3.out" } })
      intro
        .from(".hero .eyebrow", { y: 24, opacity: 0, duration: 0.8 })
        .from(split.chars, { yPercent: 130, rotateX: -100, opacity: 0, duration: 1.1, stagger: { each: 0.03, from: "random" }, ease: "back.out(1.5)" }, "-=0.5")
        .from(".hero .sub", { y: 30, opacity: 0, duration: 0.9 }, "-=0.6")
        .from(".hero .ctas > *", { y: 30, opacity: 0, scale: 0.9, stagger: 0.1, duration: 0.8, ease: "back.out(1.6)" }, "-=0.6")
        .from(".hero .chips li", { y: 18, opacity: 0, stagger: 0.08, duration: 0.6 }, "-=0.5")
        .from(".hero .stage .pm", { y: 110, rotateY: -22, rotateX: 10, opacity: 0, duration: 1.4, ease: "expo.out" }, 0.4)
        .from(".scroll-cue", { opacity: 0, duration: 1 }, "-=0.2")

      gsap.to(".aurora i", { x: "random(-90,90)", y: "random(-70,70)", scale: "random(0.85,1.25)", duration: "random(9,15)", repeat: -1, yoyo: true, ease: "sine.inOut", stagger: { each: 1.3, from: "random" } })

      // hero panel: a conversation plays, then the facts it contains appear beside it. Loops forever.
      const hero = $(".pm[data-pm='hero']")!, lines = $$(".ln", hero), counter = $(".pm-count", hero)!
      const floats = $$(".stage .float"), n = { v: 0 }
      gsap.to(".stage .fbob", { y: "+=10", duration: 2.4, yoyo: true, repeat: -1, ease: "sine.inOut", stagger: { each: 0.5, from: "start" } })
      const loop = gsap.timeline({ repeat: -1, repeatDelay: 0.8, delay: 1.6 })
      loop.set(lines, { opacity: 0, y: 14 }, 0).set(floats, { opacity: 0, scale: 0.8, y: 24 }, 0).call(() => { counter.textContent = "0"; n.v = 0 }, undefined, 0)
      lines.forEach((l, i) => loop.to(l, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, 0.4 + i * 1.0).to(n, { v: i + 1, duration: 0.01, onUpdate: () => { counter.textContent = String(Math.round(n.v)) } }, 0.4 + i * 1.0))
      floats.forEach((f, i) => loop.to(f, { opacity: 1, scale: 1, y: 0, duration: 0.7, ease: "back.out(1.7)" }, 1.8 + i * 0.95))
      loop.to([...floats, ...lines], { opacity: 0, y: -12, duration: 0.5, stagger: 0.04 }, "+=2.6")

      // pointer parallax on the hero stage
      const stage = $(".stage")!
      const rx = gsap.quickTo(hero, "rotateY", { duration: 0.8, ease: "power3" }), ry = gsap.quickTo(hero, "rotateX", { duration: 0.8, ease: "power3" })
      const parallax = (e: PointerEvent) => {
        const r = stage.getBoundingClientRect(), x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height
        rx(x * 12); ry(-y * 10)
        floats.forEach((f, i) => gsap.to(f, { x: x * (28 + i * 14), duration: 0.9, ease: "power3.out", overwrite: "auto" }))
      }
      if (desktop) { window.addEventListener("pointermove", parallax); off.push(() => window.removeEventListener("pointermove", parallax)) }

      // ---- marquee that speeds up and leans with scroll velocity
      const tr = gsap.to(".strip .track", { xPercent: -50, ease: "none", duration: 34, repeat: -1 })
      const ts = gsap.quickTo(tr, "timeScale", { duration: 0.6 }), sk = gsap.quickTo(".strip", "skewX", { duration: 0.6 })
      let idle = 0
      ScrollTrigger.create({ onUpdate: (s) => { const v = s.getVelocity(); ts(1 + Math.abs(v) / 320); sk(gsap.utils.clamp(-9, 9, -v / 260)); clearTimeout(idle); idle = window.setTimeout(() => { ts(1); sk(0) }, 140) } })
      off.push(() => clearTimeout(idle))

      // ---- section copy rises in
      gsap.set("[data-reveal]", { opacity: 0, y: 44 })
      ScrollTrigger.batch("[data-reveal]", { start: "top 88%", once: true, onEnter: (b) => gsap.to(b, { opacity: 1, y: 0, stagger: 0.1, duration: 0.95, ease: "power3.out" }) })

      // ---- statement: words light up as you scroll
      const st = SplitText.create(".statement", { type: "words", wordsClass: "w" })
      gsap.fromTo(st.words, { opacity: 0.1, y: 14 }, { opacity: 1, y: 0, stagger: 0.08, ease: "none", scrollTrigger: { trigger: ".statement", start: "top 82%", end: "bottom 46%", scrub: true } })

      // ---- how it works: a pinned, scrubbed walk through the five steps
      const steps = $$(".step"), views = $$(".pm[data-pm='how'] .pm-view"), tabs = $$(".pm[data-pm='how'] .pm-tabs span"), count = $(".pm[data-pm='how'] .pm-count")!
      let cyc: gsap.core.Timeline | undefined
      const tabOf = [0, 1, 2, 3, 2]
      const setActive = (i: number) => {
        steps.forEach((s, k) => s.classList.toggle("on", k === i))
        tabs.forEach((t, k) => t.classList.toggle("on", k === tabOf[i]))
        count.textContent = i === 0 ? "4" : "11"
      }
      setActive(0)
      gsap.set(views.slice(1), { opacity: 0, y: 40, scale: 0.96 })
      if (desktop) {
        const N = steps.length, HOLD = 0.9 // the timeline is N-1 long plus a hold so the last step finishes animating in
        const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: ".how", start: "top top", end: `+=${N * 85}%`, pin: true, scrub: 0.6, anticipatePin: 1, onUpdate: (s) => setActive(Math.min(N - 1, Math.round(s.progress * (N - 1 + HOLD)))) } })
        tl.to(".steps .rail i", { scaleY: 1, duration: N - 1 }, 0)
        for (let i = 1; i < N; i++) {
          tl.to(views[i - 1]!, { opacity: 0, y: -34, scale: 0.95, duration: 0.3, ease: "power2.in" }, i - 0.5)
            .fromTo(views[i]!, { opacity: 0, y: 44, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "power2.out" }, i - 0.15)
            .from(views[i]!.querySelectorAll(".it, .cand, .row, li, h5, .site"), { opacity: 0, y: 16, stagger: 0.06, duration: 0.3, ease: "power2.out" }, i + 0.05)
        }
        tl.to({}, { duration: HOLD }) // hold the last step
      } else {
        // phones and tablets: no pinning, the panel just cycles through its states
        cyc = gsap.timeline({ repeat: -1 })
        views.forEach((v, i) => { cyc!.call(() => setActive(i)).to(v, { opacity: 1, y: 0, scale: 1, duration: 0.5 }).to(v, { opacity: 0, y: -20, duration: 0.4 }, "+=2.2") })
        gsap.set(views[0]!, { opacity: 0 })
      }

      // ---- memory graph draws itself, then keeps pulsing; hovering isolates a node's neighbourhood
      const gt = { trigger: ".gbox", start: "top 72%", once: true }
      gsap.from(".gedge:not(.flow)", { drawSVG: "0%", duration: 1.3, stagger: 0.08, ease: "power2.out", scrollTrigger: gt })
      gsap.fromTo(".gedge.flow", { opacity: 0 }, { opacity: 0.9, duration: 1, delay: 1.6, scrollTrigger: gt })
      gsap.from(".gnode", { scale: 0, opacity: 0, transformOrigin: "50% 50%", stagger: 0.09, duration: 0.7, ease: "back.out(2.2)", scrollTrigger: gt })
      gsap.to(".gnode .ring", { scale: 2.1, opacity: 0, transformOrigin: "50% 50%", duration: 2.4, repeat: -1, ease: "power1.out", stagger: { each: 0.3, repeat: -1 } })
      const gbox = $(".gbox")!, nodes = $$<SVGGElement>(".gnode"), edges = $$<SVGPathElement>(".gedge")
      nodes.forEach((nd) => {
        const id = nd.dataset.id!
        nd.addEventListener("pointerenter", () => {
          gbox.classList.add("dim")
          const nb = new Set([id])
          edges.forEach((e) => { const on = e.dataset.a === id || e.dataset.b === id; e.classList.toggle("on", on); if (on) { nb.add(e.dataset.a!); nb.add(e.dataset.b!) } })
          nodes.forEach((x) => x.classList.toggle("on", nb.has(x.dataset.id!)))
          gsap.to(nd.querySelector(".c"), { attr: { r: 15 }, duration: 0.3 })
        })
        nd.addEventListener("pointerleave", () => { gbox.classList.remove("dim"); nodes.forEach((x) => x.classList.remove("on")); edges.forEach((e) => e.classList.remove("on")); gsap.to(nd.querySelector(".c"), { attr: { r: 10 }, duration: 0.3 }) })
      })
      gsap.from(".scope", { x: 60, opacity: 0, stagger: 0.14, duration: 0.9, ease: "power3.out", scrollTrigger: { trigger: ".scopes", start: "top 80%", once: true } })

      // ---- the trust demo: the model proposes five items, each is checked against the transcript
      const claims = $$(".claim"), tl2 = gsap.timeline({ paused: true }), tally = { kept: 0, dropped: 0 }
      const kept = $(".t-kept")!, dropped = $(".t-drop")!, total = $(".t-total")!
      const reset = () => {
        tally.kept = tally.dropped = 0; kept.textContent = "0"; dropped.textContent = "0"; total.textContent = "0"
        claims.forEach((c) => { c.classList.remove("ok", "bad"); c.querySelector(".res")!.textContent = "Checking against the transcript…" })
        $$(".tl").forEach((t) => t.classList.remove("hit"))
        gsap.set(claims, { opacity: 0, y: 24, x: 0 })
      }
      reset()
      claims.forEach((c, i) => {
        const d = CLAIMS[i]!, scan = c.querySelector(".scan")
        tl2.to(c, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, i * 1.25)
          .call(() => { total.textContent = String(i + 1) }, undefined, i * 1.25)
          .fromTo(scan, { xPercent: -110 }, { xPercent: 110, duration: 0.75, ease: "power1.inOut" }, i * 1.25 + 0.35)
          .call(() => {
            c.classList.add(d.ok ? "ok" : "bad"); c.querySelector(".res")!.textContent = d.res
            if (d.ok) { el.querySelector(`#${d.line}`)?.classList.add("hit"); tally.kept++; kept.textContent = String(tally.kept) } else { tally.dropped++; dropped.textContent = String(tally.dropped) }
          }, undefined, i * 1.25 + 0.85)
        if (!d.ok) tl2.to(c, { keyframes: { x: [0, -10, 10, -7, 7, -3, 0] }, duration: 0.5, ease: "power1.inOut" }, i * 1.25 + 0.9)
      })
      ScrollTrigger.create({ trigger: ".tgrid", start: "top 70%", once: true, onEnter: () => tl2.play() })
      const replay = $(".t-replay")!
      const onReplay = () => { tl2.pause(0); reset(); tl2.play(0) }
      replay.addEventListener("click", onReplay); off.push(() => replay.removeEventListener("click", onReplay))

      // ---- feature cards, stats, closing call to action
      gsap.from(".feat", { y: 70, opacity: 0, rotateX: -14, transformPerspective: 900, stagger: 0.09, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".bento", start: "top 82%", once: true } })
      $$(".stat b").forEach((b) => {
        const to = Number(b.dataset.n), suf = b.dataset.suf ?? "", o = { v: 0 }
        gsap.to(o, { v: to, duration: 2, ease: "power2.out", onUpdate: () => { b.textContent = Math.round(o.v) + suf }, scrollTrigger: { trigger: b, start: "top 88%", once: true } })
      })
      gsap.to(".bgring", { rotate: 360, duration: 46, repeat: -1, ease: "none" })
      gsap.fromTo(".cta h2", { scale: 0.7, opacity: 0.15 }, { scale: 1, opacity: 1, ease: "none", scrollTrigger: { trigger: ".cta", start: "top 88%", end: "top 38%", scrub: true } })
      gsap.to(".scr", { duration: 1.8, scrambleText: { text: "a memory.", chars: "01▒░█", speed: 0.55, revealDelay: 0.3 }, scrollTrigger: { trigger: ".cta", start: "top 62%", once: true } })
      const big = $(".cta .btn.primary")!
      const onHover = () => burst(big, el); big.addEventListener("pointerenter", onHover); off.push(() => big.removeEventListener("pointerenter", onHover))

      return () => { split.revert(); st.revert(); loop.kill(); cyc?.kill() }
    })

    return () => { mm.revert(); off.forEach((f) => f()); ScrollTrigger.getAll().forEach((t) => t.kill()) }
  }, [])

  return (
    <div className="lp" ref={root}>
      <style>{css}</style>
      <div className="progress" aria-hidden />
      <i className="cur-ring" aria-hidden /><i className="cur-dot" aria-hidden />

      <header className="nav">
        <a href="#top" className="brand"><span className="logo">{I.brain(15)}</span>Company Brain</a>
        <nav aria-label="Sections"><a href="#how">How it works</a><a href="#memory">Memory</a><a href="#trust">Trust</a><a href="#features">Features</a></nav>
        <a href={go} className="btn primary sm" data-magnetic="0.3"><span className="in">{goLabel}</span></a>
      </header>

      <section className="hero" id="top">
        <div className="aurora" aria-hidden><i /><i /><i /></div>
        <canvas className="neural" aria-hidden />
        <div className="vignette" aria-hidden /><div className="grain" aria-hidden />
        <div className="wrap hero-grid">
          <div>
            <p className="eyebrow"><i className="pulse" />Self-hosted team memory for Slack, Meet, Teams and Zoom</p>
            <h1 className="h1">Your team's memory, finally <em>awake</em> in every meeting.</h1>
            <p className="sub">Company Brain remembers what your team says, answers from it with sources, and turns every call into decisions and tasks with real owners. It never writes down anything that wasn't said.</p>
            <div className="ctas">
              <a href={go} className="btn primary big" data-magnetic="0.35"><span className="in">{I.slack(20)}{goLabel}</span></a>
              <a href="#how" className="btn big" data-magnetic="0.3"><span className="in">See how it works {I.down(18)}</span></a>
            </div>
            <ul className="chips"><li>Self-hosted</li><li>Private by scope</li><li>Every task cites a quote</li></ul>
          </div>
          <div className="stage">
            <PanelMock mode="hero" />
            <div className="float" style={{ left: "-13%", top: "75%" }}><div className="fbob"><i className="dotc" style={{ background: "#fbbf24" }} /><div>Decision found<small>“decided to launch on Friday”</small></div></div></div>
            <div className="float" style={{ right: "-9%", top: "84%" }}><div className="fbob"><i className="dotc" style={{ background: "#4ade80" }} /><div>Task · Parag<small>Handle the advertisements ✓ quote found</small></div></div></div>
            <div className="float" style={{ left: "24%", top: "96%" }}><div className="fbob"><i className="dotc" style={{ background: "#f472b6" }} /><div>Suggested owner · Ana<small>Light load · did similar work</small></div></div></div>
          </div>
        </div>
        <div className="scroll-cue" aria-hidden><i />scroll</div>
      </section>

      <div className="strip" aria-label="Works with"><div className="track">{[...MARQUEE, ...MARQUEE, ...MARQUEE, ...MARQUEE].map((m, i) => <span key={i}>{m}</span>)}</div></div>

      <section className="sec"><div className="wrap">
        <p className="statement">Decisions get lost in threads. Tasks float without owners. Last week's context is gone by Monday. <em>Company Brain remembers all of it</em>, so nobody has to.</p>
      </div></section>

      <section className="how" id="how">
        <div className="wrap how-grid">
          <div>
            <p className="eyebrow" data-reveal>From a live call to remembered work</p>
            <h2 className="sec-h" style={{ fontSize: "clamp(30px,4vw,52px)", marginTop: 18 }} data-reveal>Every meeting, <span className="grad">handled</span>.</h2>
            <div className="steps" style={{ marginTop: 34 }}>
              <div className="rail"><i /></div>
              {STEPS.map((s, i) => <div key={s.n} className={`step${i === 0 ? " on" : ""}`}><div className="n mono">{s.n}</div><h3>{s.h}</h3><p>{s.p}</p></div>)}
            </div>
          </div>
          <div className="how-stage"><div className="glow" aria-hidden /><PanelMock mode="how" /></div>
        </div>
      </section>

      <section className="sec" id="memory"><div className="wrap">
        <p className="eyebrow" data-reveal>Memory with a permission slip</p>
        <h2 className="sec-h" data-reveal style={{ marginTop: 20 }}>Everything your team says becomes <span className="grad">connected memory</span>.</h2>
        <p className="sec-p" data-reveal>Threads, huddles, calls, documents, decisions, tasks and people link up, so "what did we decide about the deployment?" gets an answer with sources you can open. Hover the graph to follow a thread.</p>
        <div className="mem-grid">
          <div className="gbox" data-hot>
            <svg viewBox="0 0 820 540" role="img" aria-label="A graph linking threads, meetings, decisions, tasks and people">
              <defs><linearGradient id="gflow" x1="0" x2="1"><stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
              {GRAPH.edges.map(([a, b], i) => { const A = GRAPH.nodes.find((n) => n.id === a)!, B = GRAPH.nodes.find((n) => n.id === b)!, mx = (A.x + B.x) / 2 + (i % 2 ? 26 : -26), my = (A.y + B.y) / 2 + (i % 3 ? -22 : 22), d = `M${A.x},${A.y} Q${mx},${my} ${B.x},${B.y}`; return <g key={i}><path className="gedge" d={d} data-a={a} data-b={b} /><path className="gedge flow" d={d} data-a={a} data-b={b} /></g> })}
              {GRAPH.nodes.map((n) => (
                <g key={n.id} className="gnode" data-id={n.id} transform={`translate(${n.x},${n.y})`}>
                  <circle className="ring" r="10" stroke={n.c} /><circle className="c" r="10" fill={n.c} /><circle r="4" fill="#05060b" />
                  <text x="16" y="4">{n.label}</text>
                </g>
              ))}
            </svg>
          </div>
          <div className="scopes">
            {SCOPES.map((s) => (
              <div className="scope" key={s.h}><span className="ic" style={{ background: `${s.c}22`, color: s.c }}>{s.icon(22)}</span><h3>{s.h}</h3><p>{s.p}</p></div>
            ))}
          </div>
        </div>
      </div></section>

      <section className="sec trust" id="trust"><div className="wrap">
        <p className="eyebrow" data-reveal>The rule that makes notes trustworthy</p>
        <h2 className="sec-h" data-reveal style={{ marginTop: 20 }}>If it wasn't said, <span className="grad">it isn't saved</span>.</h2>
        <p className="sec-p" data-reveal>A model proposes decisions and tasks, but every one has to point to words that really appear in the transcript. Anything it can't back up is dropped, never "fixed". Watch it happen.</p>
        <div className="tgrid">
          <div className="tcard"><h4><span>Transcript</span><span className="mono">4 lines</span></h4>
            {TRUST_LINES.map((l) => <div className="tl" id={l.id} key={l.id}><b>{l.who}:</b> {l.t}</div>)}
          </div>
          <div className="tcard"><h4><span>What the model proposed</span><button className="btn sm t-replay" type="button" data-magnetic="0.2"><span className="in">Replay</span></button></h4>
            {CLAIMS.map((c) => <div className="claim" key={c.ttl}><i className="scan" /><div className="top"><span className="ttl">{c.ttl}</span></div><div className="res">Checking against the transcript…</div></div>)}
            <div className="tsum"><div><b className="t-total">0</b>proposed</div><div><b className="t-kept" style={{ color: "#4ade80" }}>0</b>kept</div><div><b className="t-drop" style={{ color: "#fb7185" }}>0</b>dropped</div></div>
          </div>
        </div>
      </div></section>

      <section className="sec" id="features"><div className="wrap">
        <p className="eyebrow" data-reveal>What's inside</p>
        <h2 className="sec-h" data-reveal style={{ marginTop: 20 }}>One brain for <span className="grad">chat, calls and tasks</span>.</h2>
        <div className="bento">
          {FEATURES.map((f) => (
            <article key={f.h} className={`feat ${f.w ?? ""}`} data-spot data-tilt>
              <div className="fi" style={{ color: f.c }}>{f.icon}</div>
              <h3>{f.h}</h3><p>{f.p}</p>
              <div className="tags">{f.tags.map((t) => <span key={t}>{t}</span>)}</div>
            </article>
          ))}
        </div>
      </div></section>

      <section className="sec" style={{ paddingTop: 20 }}><div className="wrap">
        <div className="stats">
          <div className="stat"><b data-n="3">0</b><span>memory scopes: shared, private channels, and just you</span></div>
          <div className="stat"><b data-n="1">0</b><span>pass over the whole transcript to write decisions and tasks</span></div>
          <div className="stat"><b data-n="100" data-suf="%">0</b><span>of saved tasks carry a quote that was verified</span></div>
          <div className="stat"><b data-n="0">0</b><span>direct messages sent automatically from extension uploads</span></div>
        </div>
      </div></section>

      <section className="cta">
        <div className="bgring" aria-hidden /><div className="grain" aria-hidden />
        <div className="wrap">
          <h2>Give your team<br /><span className="grad scr">a memory.</span></h2>
          <p>Sign in with the Slack workspace this deployment belongs to, and your next meeting writes its own notes.</p>
          <div className="ctas" style={{ marginTop: 42 }}><a href={go} className="btn primary big" data-magnetic="0.4"><span className="in">{I.slack(20)}{goLabel} {I.arrow(18)}</span></a></div>
          {!signedIn && <p style={{ marginTop: 22, fontSize: 14 }}><a href="/setup" style={{ color: "var(--mut)", textDecoration: "underline", textUnderlineOffset: 4 }}>Setting up a new deployment?</a></p>}
        </div>
      </section>

      <footer className="foot"><div className="wrap"><span>Company Brain · self-hosted on Bun, Hono and Postgres (pgvector)</span><span><a href={go}>{goLabel}</a></span></div></footer>
    </div>
  )
}
