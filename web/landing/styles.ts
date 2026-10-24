// Landing page styles. Everything is scoped under .lp so nothing leaks into the app.
export const css = String.raw`
.lp { --bg:#05060b; --fg:#eef1fa; --mut:#9aa3bd; --dim:#6b7391; --line:rgba(255,255,255,.09); --card:rgba(255,255,255,.04);
  --teal:#2dd4bf; --cyan:#22d3ee; --violet:#8b5cf6; --pink:#f472b6; --amber:#fbbf24; --red:#fb7185; --green:#4ade80;
  position:relative; background:var(--bg); color:var(--fg); min-height:100dvh; overflow-x:clip; font-size:16px; line-height:1.55; letter-spacing:-.01em; color-scheme:dark; }
.lp *, .lp *::before, .lp *::after { box-sizing:border-box; }
.lp a { color:inherit; text-decoration:none; }
.lp h1, .lp h2, .lp h3, .lp p { margin:0; }
.lp ::selection { background:rgba(45,212,191,.35); }
.lp .wrap { width:min(1200px, 100% - 48px); margin-inline:auto; }
.lp .mono { font-family:"JetBrains Mono", ui-monospace, monospace; }
.lp .grad { background:linear-gradient(100deg,var(--teal),var(--cyan) 40%,var(--violet) 75%,var(--pink)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.lp .eyebrow { display:inline-flex; gap:10px; align-items:center; font-size:13px; font-weight:600; letter-spacing:.02em; color:var(--mut); padding:7px 14px; border:1px solid var(--line); border-radius:999px; background:rgba(255,255,255,.03); backdrop-filter:blur(8px); }
.lp .pulse { width:8px; height:8px; border-radius:50%; background:var(--green); box-shadow:0 0 0 0 rgba(74,222,128,.6); animation:lpPulse 1.8s infinite; }
@keyframes lpPulse { 70% { box-shadow:0 0 0 9px rgba(74,222,128,0); } 100% { box-shadow:0 0 0 0 rgba(74,222,128,0); } }
.lp .sec { padding:120px 0; position:relative; }
.lp .sec-h { font-size:clamp(34px, 5.2vw, 68px); line-height:1.03; letter-spacing:-.035em; font-weight:700; max-width:900px; }
.lp .sec-p { color:var(--mut); font-size:clamp(16px,1.5vw,19px); max-width:620px; margin-top:22px; }

/* progress + cursor + grain */
.lp .progress { position:fixed; left:0; top:0; height:3px; width:100%; transform-origin:0 50%; transform:scaleX(0); z-index:60; background:linear-gradient(90deg,var(--teal),var(--violet),var(--pink)); }
.lp .cur-dot, .lp .cur-ring { position:fixed; left:0; top:0; pointer-events:none; z-index:80; border-radius:50%; mix-blend-mode:difference; opacity:0; }
.lp .cur-dot { width:8px; height:8px; margin:-4px 0 0 -4px; background:#fff; }
.lp .cur-ring { width:38px; height:38px; margin:-19px 0 0 -19px; border:1.5px solid #fff; transition:width .25s, height .25s, margin .25s, background .25s; }
.lp .cur-ring.hot { width:74px; height:74px; margin:-37px 0 0 -37px; background:#fff; }
@media (hover:none), (prefers-reduced-motion:reduce) { .lp .cur-dot, .lp .cur-ring { display:none; } }
.lp .grain { position:absolute; inset:0; pointer-events:none; opacity:.07; mix-blend-mode:overlay; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }

/* nav */
.lp .nav { position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:50; width:min(1120px, 100% - 28px); display:flex; align-items:center; gap:18px; padding:9px 10px 9px 18px; border:1px solid var(--line); border-radius:999px; background:rgba(8,10,18,.6); backdrop-filter:blur(16px) saturate(1.4); transition:transform .4s cubic-bezier(.2,.8,.2,1); }
.lp .nav.hide { transform:translate(-50%, -140%); }
.lp .brand { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:-.02em; }
.lp .brand .logo { width:26px; height:26px; border-radius:8px; display:grid; place-items:center; background:linear-gradient(135deg,var(--teal),var(--violet)); }
.lp .nav nav { margin-left:auto; display:flex; gap:4px; }
.lp .nav nav a { padding:8px 14px; border-radius:999px; font-size:14px; font-weight:550; color:var(--mut); transition:color .2s, background .2s; }
.lp .nav nav a:hover { color:var(--fg); background:rgba(255,255,255,.06); }
@media (max-width:820px) { .lp .nav nav { display:none; } .lp .nav .btn { margin-left:auto; } }

/* buttons */
.lp .btn { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:10px; height:46px; padding:0 22px; border-radius:999px; font-weight:650; font-size:15px; border:1px solid var(--line); background:rgba(255,255,255,.05); color:var(--fg); cursor:pointer; will-change:transform; transition:background .2s, border-color .2s; }
.lp .btn:hover { background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.22); }
.lp .btn.primary { color:#04110f; border-color:transparent; background:linear-gradient(110deg,var(--teal),var(--cyan) 55%,#7dd3fc); box-shadow:0 8px 40px -8px rgba(45,212,191,.7), inset 0 1px 0 rgba(255,255,255,.5); }
.lp .btn.primary:hover { filter:brightness(1.08); }
.lp .btn.sm { height:38px; padding:0 16px; font-size:14px; }
.lp .btn.big { height:62px; padding:0 38px; font-size:18px; }
.lp .btn .in { display:inline-flex; align-items:center; gap:10px; pointer-events:none; }
.lp .particle { position:fixed; width:7px; height:7px; border-radius:50%; pointer-events:none; z-index:70; }

/* hero */
.lp .hero { position:relative; min-height:100dvh; padding:150px 0 90px; display:flex; align-items:center; overflow:hidden; isolation:isolate; }
.lp .neural { position:absolute; inset:0; width:100%; height:100%; z-index:-2; }
.lp .aurora { position:absolute; inset:0; z-index:-3; overflow:hidden; }
.lp .aurora i { position:absolute; width:60vw; height:60vw; max-width:900px; max-height:900px; border-radius:50%; filter:blur(110px); opacity:.5; }
.lp .aurora i:nth-child(1) { background:radial-gradient(circle,#0d9488,transparent 65%); left:-12%; top:-18%; }
.lp .aurora i:nth-child(2) { background:radial-gradient(circle,#6d28d9,transparent 65%); right:-14%; top:6%; }
.lp .aurora i:nth-child(3) { background:radial-gradient(circle,#be185d,transparent 65%); left:30%; bottom:-30%; opacity:.32; }
.lp .vignette { position:absolute; inset:0; z-index:-1; pointer-events:none; background:radial-gradient(ellipse at 50% 40%, transparent 30%, var(--bg) 100%); }
.lp .hero-grid { display:grid; grid-template-columns:1.05fr .95fr; gap:40px; align-items:center; }
.lp .h1 { font-size:clamp(40px, 6.1vw, 92px); line-height:1; letter-spacing:-.045em; font-weight:750; margin:26px 0 0; perspective:900px; }
.lp .h1 .wd { display:inline-block; white-space:nowrap; }
.lp .h1 .ch { display:inline-block; transform-origin:50% 100%; will-change:transform; }
.lp .hero .sub { margin-top:28px; font-size:clamp(17px,1.7vw,21px); color:var(--mut); max-width:560px; }
.lp .ctas { display:flex; flex-wrap:wrap; gap:14px; margin-top:38px; }
.lp .chips { display:flex; flex-wrap:wrap; gap:10px; margin-top:34px; padding:0; list-style:none; }
.lp .chips li { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--mut); padding:6px 12px; border-radius:999px; border:1px solid var(--line); background:rgba(255,255,255,.03); }
.lp .chips li::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--teal); }
.lp .stage { position:relative; perspective:1200px; }
.lp .float { position:absolute; z-index:3; display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:14px; font-size:13px; font-weight:600; border:1px solid var(--line); background:rgba(12,15,26,.82); backdrop-filter:blur(14px); box-shadow:0 20px 50px -20px rgba(0,0,0,.8); }
.lp .float .dotc { width:8px; height:8px; border-radius:50%; flex:none; }
.lp .float small { display:block; color:var(--dim); font-weight:500; font-size:11.5px; }
.lp .scroll-cue { position:absolute; bottom:26px; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:8px; font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
.lp .scroll-cue i { width:1px; height:42px; background:linear-gradient(var(--teal),transparent); animation:lpDrip 2s infinite; transform-origin:top; }
@keyframes lpDrip { 0% { transform:scaleY(0); } 50% { transform:scaleY(1); } 100% { transform:scaleY(1); opacity:0; } }
@media (max-width:940px) { .lp .hero-grid { grid-template-columns:1fr; } .lp .stage { margin-top:30px; } .lp .float { display:none; } }

/* panel mock (mirrors the real extension side panel) */
.lp .pm { width:min(400px,100%); margin-inline:auto; border-radius:22px; background:linear-gradient(180deg,#14172a,#0d1020); border:1px solid rgba(255,255,255,.12); box-shadow:0 50px 120px -30px rgba(45,212,191,.35), 0 30px 80px -20px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.08); overflow:hidden; text-align:left; font-size:13px; }
.lp .pm-head { display:flex; align-items:center; gap:10px; padding:14px 14px 10px; }
.lp .pm-logo { width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg,var(--teal),var(--violet)); display:grid; place-items:center; flex:none; }
.lp .pm-title { font-weight:650; font-size:13.5px; line-height:1.2; }
.lp .pm-sub { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:11.5px; }
.lp .pm-dot { width:7px; height:7px; border-radius:50%; background:var(--green); animation:lpPulse 1.8s infinite; }
.lp .pm-tabs { display:flex; gap:2px; margin:0 12px; padding:3px; border-radius:11px; background:rgba(255,255,255,.05); }
.lp .pm-tabs span { flex:1; text-align:center; font-size:10.5px; font-weight:650; color:var(--dim); padding:6px 0; border-radius:8px; position:relative; transition:background .3s, color .3s; }
.lp .pm-tabs span.on { background:rgba(255,255,255,.1); color:var(--teal); }
.lp .pm-tabs span b { position:absolute; top:-3px; right:6px; background:var(--teal); color:#04110f; border-radius:99px; font-size:9px; padding:0 5px; line-height:14px; }
.lp .pm-body { position:relative; height:360px; padding:12px; overflow:hidden; }
.lp .pm-view { position:absolute; inset:12px; display:flex; flex-direction:column; gap:8px; }
.lp .ln { display:grid; grid-template-columns:26px 1fr; gap:9px; padding:6px 6px; border-radius:10px; }
.lp .av { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-size:10px; font-weight:750; color:#fff; flex:none; }
.lp .ln .who { font-weight:650; font-size:11.5px; display:flex; gap:6px; align-items:baseline; }
.lp .ln .who em { font-style:normal; color:var(--dim); font-weight:500; font-size:10.5px; }
.lp .ln .say { color:#d6dbeb; font-size:12.5px; line-height:1.45; }
.lp .ln.hl .say mark { background:rgba(45,212,191,.22); color:#eafffb; border-radius:4px; padding:0 3px; box-shadow:0 0 0 1px rgba(45,212,191,.5); }
.lp .note h5, .lp .sent h5 { margin:0 0 4px; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--teal); }
.lp .note ul { margin:0 0 8px; padding-left:16px; color:#d6dbeb; font-size:12.5px; } .lp .note li { margin:3px 0; }
.lp .it { position:relative; border:1px solid var(--line); border-radius:13px; padding:10px 12px 10px 14px; background:rgba(255,255,255,.04); }
.lp .it::before { content:""; position:absolute; left:0; top:10px; bottom:10px; width:3px; border-radius:0 3px 3px 0; background:var(--green); }
.lp .it.dec::before { background:var(--violet); } .lp .it.q::before { background:var(--cyan); }
.lp .badge { display:inline-block; font-size:10px; font-weight:700; border-radius:99px; padding:1px 8px; background:rgba(74,222,128,.14); color:var(--green); }
.lp .badge.v { background:rgba(139,92,246,.18); color:#c4b5fd; } .lp .badge.c { background:rgba(34,211,238,.14); color:var(--cyan); } .lp .badge.r { background:rgba(251,113,133,.15); color:var(--red); } .lp .badge.t { background:rgba(45,212,191,.14); color:var(--teal); }
.lp .it .t { font-weight:650; font-size:13px; margin-top:4px; } .lp .it .m { color:var(--mut); font-size:11.5px; margin-top:2px; }
.lp .cand { display:grid; grid-template-columns:30px 1fr auto; gap:2px 10px; align-items:center; padding:9px 4px; border-bottom:1px solid var(--line); }
.lp .cand .nm { font-weight:650; font-size:12.5px; } .lp .cand .tt { color:var(--dim); font-size:11px; }
.lp .cand .go { grid-row:1/3; grid-column:3; font-size:11px; font-weight:700; padding:5px 11px; border-radius:99px; background:linear-gradient(110deg,var(--teal),var(--cyan)); color:#04110f; }
.lp .cand .why { grid-column:2/4; color:var(--mut); font-size:11px; }
.lp .pill { display:inline-block; font-size:9.5px; font-weight:700; border-radius:99px; padding:1px 7px; margin-right:4px; background:rgba(74,222,128,.14); color:var(--green); } .lp .pill.b { background:rgba(251,191,36,.15); color:var(--amber); }
.lp .sent { display:flex; flex-direction:column; gap:8px; }
.lp .site { border:1px solid var(--line); border-radius:14px; padding:12px; background:rgba(255,255,255,.035); }
.lp .site .row { display:flex; justify-content:space-between; gap:8px; padding:7px 0; border-bottom:1px dashed var(--line); font-size:12.5px; } .lp .site .row:last-child { border:0; }
.lp .site .row span:last-child { color:var(--mut); }
.lp .tick { color:var(--green); font-weight:800; }

/* marquee */
.lp .strip { position:relative; border-block:1px solid var(--line); background:rgba(255,255,255,.02); overflow:hidden; padding:22px 0; will-change:transform; }
.lp .strip .track { display:flex; width:max-content; gap:56px; white-space:nowrap; will-change:transform; }
.lp .strip span { display:inline-flex; align-items:center; gap:14px; font-size:clamp(18px,2.2vw,28px); font-weight:650; color:var(--dim); letter-spacing:-.02em; }
.lp .strip span::after { content:"✦"; color:var(--teal); font-size:.7em; }

/* statement */
.lp .statement { font-size:clamp(30px, 4.6vw, 64px); line-height:1.12; letter-spacing:-.035em; font-weight:700; max-width:1080px; }
.lp .statement .w { display:inline-block; }

/* how it works */
.lp .how { position:relative; min-height:100dvh; display:flex; align-items:center; padding:90px 0 40px; overflow:hidden; }
.lp .how-grid { display:grid; grid-template-columns:.9fr 1.1fr; gap:60px; align-items:center; }
.lp .steps { position:relative; padding-left:34px; display:flex; flex-direction:column; gap:6px; }
.lp .steps .rail { position:absolute; left:6px; top:8px; bottom:8px; width:2px; background:var(--line); border-radius:2px; overflow:hidden; }
.lp .steps .rail i { position:absolute; inset:0; transform-origin:0 0; transform:scaleY(0); background:linear-gradient(var(--teal),var(--violet),var(--pink)); }
.lp .step { position:relative; padding:14px 0; opacity:.38; transition:opacity .4s, transform .4s; }
.lp .step::before { content:""; position:absolute; left:-33px; top:23px; width:12px; height:12px; border-radius:50%; background:var(--bg); border:2px solid var(--dim); transition:all .4s; }
.lp .step.on { opacity:1; transform:translateX(6px); }
.lp .step.on::before { border-color:var(--teal); background:var(--teal); box-shadow:0 0 0 6px rgba(45,212,191,.18); }
.lp .step .n { font-size:12px; color:var(--teal); font-weight:700; letter-spacing:.14em; }
.lp .step h3 { font-size:clamp(22px,2.4vw,32px); letter-spacing:-.03em; margin-top:2px; line-height:1.1; }
.lp .step p { color:var(--mut); margin-top:8px; max-width:440px; font-size:15.5px; display:none; }
.lp .step.on p { display:block; }
.lp .how-stage { position:relative; display:grid; place-items:center; }
.lp .how-stage .glow { position:absolute; width:90%; aspect-ratio:1; border-radius:50%; background:radial-gradient(circle,rgba(139,92,246,.35),rgba(45,212,191,.12) 45%,transparent 70%); filter:blur(30px); z-index:-1; }
@media (max-width:940px) { .lp .how { min-height:0; padding:100px 0; } .lp .how-grid { grid-template-columns:1fr; } .lp .step { opacity:1; } .lp .step p { display:block; } }

/* memory */
.lp .mem-grid { display:grid; grid-template-columns:1.15fr .85fr; gap:40px; margin-top:60px; align-items:center; }
.lp .gbox { position:relative; border:1px solid var(--line); border-radius:28px; background:radial-gradient(ellipse at 30% 20%, rgba(45,212,191,.08), transparent 60%), rgba(255,255,255,.025); padding:10px; overflow:hidden; }
.lp .gbox svg { width:100%; height:auto; display:block; overflow:visible; }
.lp .gedge { stroke:rgba(255,255,255,.18); stroke-width:1.4; fill:none; }
.lp .gedge.flow { stroke:url(#gflow); stroke-dasharray:6 10; animation:lpFlow 1.6s linear infinite; }
@keyframes lpFlow { to { stroke-dashoffset:-32; } }
.lp .gnode { cursor:pointer; }
.lp .gnode circle.c { transition:r .3s; }
.lp .gnode text { font-size:12.5px; font-weight:600; fill:#dfe4f5; pointer-events:none; paint-order:stroke; stroke:#05060b; stroke-width:4px; }
.lp .gbox.dim .gnode:not(.on), .lp .gbox.dim .gedge:not(.on) { opacity:.16; transition:opacity .3s; }
.lp .gnode .ring { fill:none; stroke-width:1.5; opacity:.45; }
.lp .scopes { display:grid; gap:14px; }
.lp .scope { position:relative; display:grid; grid-template-columns:44px 1fr; gap:4px 16px; padding:20px; border:1px solid var(--line); border-radius:20px; background:rgba(255,255,255,.035); overflow:hidden; }
.lp .scope .ic { width:44px; height:44px; border-radius:14px; display:grid; place-items:center; grid-row:1/3; }
.lp .scope h3 { font-size:18px; letter-spacing:-.02em; } .lp .scope p { color:var(--mut); font-size:14.5px; }
@media (max-width:940px) { .lp .mem-grid { grid-template-columns:1fr; } }

/* trust demo */
.lp .trust { background:linear-gradient(180deg,transparent,rgba(139,92,246,.06) 40%,transparent); }
.lp .tgrid { display:grid; grid-template-columns:1fr 1fr; gap:26px; margin-top:56px; align-items:start; }
.lp .tcard { border:1px solid var(--line); border-radius:24px; padding:22px; background:rgba(255,255,255,.03); }
.lp .tcard > h4 { margin:0 0 14px; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); display:flex; justify-content:space-between; }
.lp .tl { padding:9px 11px; border-radius:12px; font-size:14.5px; color:#cfd5ea; border:1px solid transparent; transition:background .4s, border-color .4s; }
.lp .tl b { color:var(--teal); font-weight:650; }
.lp .tl.hit { background:rgba(45,212,191,.12); border-color:rgba(45,212,191,.45); }
.lp .claim { position:relative; padding:13px 14px; margin-bottom:10px; border:1px solid var(--line); border-radius:15px; background:rgba(255,255,255,.04); overflow:hidden; }
.lp .claim .top { display:flex; justify-content:space-between; gap:10px; align-items:center; }
.lp .claim .ttl { font-weight:650; font-size:15px; }
.lp .claim .res { font-size:12px; margin-top:6px; color:var(--dim); min-height:18px; }
.lp .claim .scan { position:absolute; inset:0; background:linear-gradient(100deg,transparent 35%,rgba(45,212,191,.35) 50%,transparent 65%); transform:translateX(-110%); pointer-events:none; }
.lp .claim.ok { border-color:rgba(74,222,128,.55); background:rgba(74,222,128,.07); } .lp .claim.ok .res { color:var(--green); }
.lp .claim.bad { border-color:rgba(251,113,133,.6); background:rgba(251,113,133,.08); } .lp .claim.bad .ttl { text-decoration:line-through; text-decoration-color:var(--red); color:var(--mut); } .lp .claim.bad .res { color:var(--red); }
.lp .tsum { display:flex; flex-wrap:wrap; gap:26px; margin-top:16px; padding-top:16px; border-top:1px dashed var(--line); }
.lp .tsum div { font-size:12px; color:var(--dim); } .lp .tsum b { display:block; font-size:28px; color:var(--fg); letter-spacing:-.03em; }
@media (max-width:940px) { .lp .tgrid { grid-template-columns:1fr; } }

/* features bento */
.lp .bento { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; margin-top:60px; }
.lp .feat { position:relative; grid-column:span 4; padding:26px; border-radius:26px; border:1px solid var(--line); background:rgba(255,255,255,.03); overflow:hidden; transform-style:preserve-3d; will-change:transform; }
.lp .feat.w6 { grid-column:span 6; } .lp .feat.w8 { grid-column:span 8; }
.lp .feat::before { content:""; position:absolute; inset:0; background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%), rgba(45,212,191,.16), transparent 60%); opacity:0; transition:opacity .3s; pointer-events:none; }
.lp .feat:hover::before { opacity:1; }
.lp .feat::after { content:""; position:absolute; inset:0; border-radius:inherit; padding:1px; background:radial-gradient(260px circle at var(--mx,50%) var(--my,0%), rgba(255,255,255,.55), transparent 70%); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; opacity:0; transition:opacity .3s; pointer-events:none; }
.lp .feat:hover::after { opacity:.8; }
.lp .feat .fi { width:48px; height:48px; border-radius:15px; display:grid; place-items:center; margin-bottom:18px; background:rgba(255,255,255,.06); border:1px solid var(--line); }
.lp .feat h3 { font-size:21px; letter-spacing:-.025em; line-height:1.15; } .lp .feat p { color:var(--mut); margin-top:10px; font-size:15px; }
.lp .feat .tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:16px; } .lp .feat .tags span { font-size:11.5px; color:var(--mut); border:1px solid var(--line); border-radius:99px; padding:3px 10px; }
@media (max-width:940px) { .lp .feat, .lp .feat.w6, .lp .feat.w8 { grid-column:span 12; } }
@media (min-width:941px) and (max-width:1100px) { .lp .feat { grid-column:span 6; } .lp .feat.w8 { grid-column:span 12; } }

/* stats */
.lp .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:0; border:1px solid var(--line); border-radius:28px; overflow:hidden; background:rgba(255,255,255,.025); }
.lp .stat { padding:38px 28px; border-right:1px solid var(--line); } .lp .stat:last-child { border:0; }
.lp .stat b { display:block; font-size:clamp(44px,5.6vw,78px); line-height:1; letter-spacing:-.05em; font-weight:750; }
.lp .stat span { display:block; margin-top:12px; color:var(--mut); font-size:15px; max-width:230px; }
@media (max-width:940px) { .lp .stats { grid-template-columns:1fr 1fr; } .lp .stat:nth-child(2) { border-right:0; } .lp .stat:nth-child(-n+2) { border-bottom:1px solid var(--line); } }

/* cta */
.lp .cta { position:relative; padding:170px 0 150px; text-align:center; overflow:hidden; isolation:isolate; }
.lp .cta .bgring { position:absolute; left:50%; top:50%; width:140vmax; aspect-ratio:1; transform:translate(-50%,-50%); z-index:-1; border-radius:50%; background:conic-gradient(from 0deg, rgba(45,212,191,.0), rgba(45,212,191,.22), rgba(139,92,246,.22), rgba(244,114,182,.18), rgba(45,212,191,0)); filter:blur(60px); }
.lp .cta h2 { font-size:clamp(46px, 9vw, 140px); line-height:.95; letter-spacing:-.05em; font-weight:780; }
.lp .cta p { color:var(--mut); font-size:19px; margin:28px auto 0; max-width:560px; }
.lp .cta .ctas { justify-content:center; }
.lp footer.foot { border-top:1px solid var(--line); padding:34px 0 50px; color:var(--dim); font-size:13.5px; }
.lp footer.foot .wrap { display:flex; flex-wrap:wrap; gap:16px 30px; justify-content:space-between; align-items:center; }
.lp footer.foot a:hover { color:var(--fg); }

.lp .fbob { display:flex; align-items:center; gap:10px; }
.lp .pm[data-pm="how"] .pm-view:not([data-view="0"]) { opacity:0; }
.lp .statement em { font-style:normal; color:var(--teal); }
.lp .h1 em { font-style:normal; }
.lp .scr { display:inline-block; }
@media (prefers-reduced-motion:reduce) { .lp .pm[data-pm="how"] .pm-view:not([data-view="2"]) { opacity:0; } .lp .pm[data-pm="how"] .pm-view[data-view="2"] { opacity:1; } .lp .pm[data-pm="how"] .pm-view[data-view="0"] { opacity:0; } .lp .step { opacity:1; } .lp .step p { display:block; } }
@media (prefers-reduced-motion:reduce) { .lp *, .lp *::before, .lp *::after { animation:none !important; transition:none !important; } }
`
