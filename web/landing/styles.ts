// Landing page styles. Scoped under .lp so nothing leaks into the app. Near-black, warm off-white, one yellow accent.
export const css = String.raw`
.lp { --bg:#0b0b0c; --card:#141416; --card2:#1b1b1e; --line:#27272b; --fg:#f4f2eb; --mut:#a29e93; --hl:#ffe14d; --green:#3ddc84; --red:#ff6b6b; --amber:#ffb84d; --paper:#f5f1e8; --ink:#15130f;
  background:var(--bg); color:var(--fg); min-height:100dvh; overflow-x:clip; font-size:17px; line-height:1.55; letter-spacing:-.011em; color-scheme:dark; }
.lp *, .lp *::before, .lp *::after { box-sizing:border-box; }
.lp a { color:inherit; text-decoration:none; }
.lp h1, .lp h2, .lp h3, .lp p { margin:0; }
.lp button { font:inherit; }
.lp ::selection { background:var(--hl); color:#111; }
.lp .wrap { width:min(1180px, 100% - 48px); margin-inline:auto; }
.lp .mono { font-family:"JetBrains Mono", ui-monospace, monospace; }
.lp .sec { padding:120px 0; position:relative; }
.lp .tag { font-size:12.5px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); }
.lp h2.big { font-size:clamp(34px, 4.8vw, 64px); line-height:1.03; letter-spacing:-.04em; font-weight:760; }
.lp .lead { color:var(--mut); font-size:clamp(17px,1.5vw,20px); max-width:560px; margin-top:20px; }
.lp .it { font-family:"Instrument Serif", ui-serif, Georgia, "Times New Roman", serif; font-style:italic; font-weight:400; letter-spacing:-.02em; font-size:1.1em; }
.lp .hl { position:relative; z-index:0; white-space:nowrap; color:#111; }
.lp .hl::before { content:""; position:absolute; left:-.1em; right:-.1em; top:12%; bottom:6%; background:var(--hl); z-index:-1; border-radius:4px; transform-origin:0 50%; transform:scaleX(var(--s,1)) rotate(-.7deg); }

/* nav */
.lp .nav { position:sticky; top:0; z-index:50; border-bottom:1px solid transparent; transition:background .3s, border-color .3s, backdrop-filter .3s; }
.lp .nav.scrolled { background:rgba(11,11,12,.82); backdrop-filter:blur(14px); border-color:var(--line); }
.lp .nav .wrap { display:flex; align-items:center; gap:30px; height:68px; }
.lp .brand { display:flex; align-items:center; gap:10px; font-weight:760; letter-spacing:-.025em; font-size:18px; white-space:nowrap; }
.lp .brand i { width:28px; height:28px; border-radius:8px; background:var(--hl); display:grid; place-items:center; }
.lp .nav .links { display:flex; gap:26px; font-size:15px; font-weight:550; color:var(--mut); margin-left:14px; }
.lp .nav .links a:hover { color:var(--fg); }
.lp .nav .right { margin-left:auto; display:flex; align-items:center; gap:22px; font-size:15px; font-weight:600; }
@media (max-width:820px) { .lp .nav .links, .lp .nav .plain { display:none; } }

/* buttons: the label rolls up on hover */
.lp .btn { display:inline-flex; align-items:center; gap:10px; height:52px; padding:0 26px; border-radius:999px; font-weight:680; font-size:16px; cursor:pointer; border:1px solid transparent; transition:transform .2s, background .2s, border-color .2s; }
.lp .btn:hover { transform:translateY(-2px); }
.lp .btn.pri { background:var(--hl); color:#111; }
.lp .btn.ghost { border-color:#3a3a40; color:var(--fg); background:rgba(255,255,255,.03); }
.lp .btn.ghost:hover { border-color:#6a6a72; background:rgba(255,255,255,.07); }
.lp .btn.sm { height:42px; padding:0 20px; font-size:15px; }
.lp .btn .roll { display:inline-block; position:relative; height:1.3em; overflow:hidden; line-height:1.3; }
.lp .btn .roll span { display:block; transition:transform .38s cubic-bezier(.7,0,.2,1); }
.lp .btn .roll span + span { position:absolute; left:0; top:100%; }
.lp .btn:hover .roll span { transform:translateY(-100%); }
.lp .tlink { display:inline-flex; align-items:center; gap:8px; font-weight:650; color:var(--fg); }
.lp .tlink:hover { color:var(--hl); }

/* hero */
.lp .hero { position:relative; text-align:center; padding:60px 0 30px; }
.lp .hero::before { content:""; position:absolute; left:50%; top:-80px; width:980px; height:720px; transform:translateX(-50%); background:radial-gradient(closest-side, rgba(255,225,77,.11), transparent); pointer-events:none; }
.lp .h1 { font-size:clamp(44px, 6.8vw, 100px); line-height:.98; letter-spacing:-.048em; font-weight:790; position:relative; margin-top:26px; }
.lp .h1 .ln { padding-bottom:.1em; }
.lp .hero .sub { margin:28px auto 0; font-size:clamp(18px,1.7vw,22px); color:var(--mut); max-width:640px; }
.lp .bul { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 30px; list-style:none; padding:0; margin:30px 0 0; font-size:15.5px; font-weight:560; }
.lp .bul li { display:inline-flex; align-items:center; gap:9px; } .lp .bul svg { color:var(--hl); flex:none; }
.lp .ctas { display:flex; flex-wrap:wrap; justify-content:center; gap:14px; margin-top:34px; }
.lp .fine { margin-top:20px; font-size:14px; color:var(--mut); }
.lp .works { display:flex; align-items:center; justify-content:center; gap:16px; margin-top:34px; font-size:13.5px; color:var(--mut); font-weight:600; }
.lp .tile { display:inline-grid; place-items:center; border-radius:24%; background:#fff; box-shadow:0 12px 26px -12px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.08); }

/* the big product preview */
.lp .hwrap { margin-top:54px; perspective:1600px; }
.lp .hw { max-width:1060px; margin-inline:auto; border-radius:18px; background:#1c1c1f; border:1px solid #2c2c31; box-shadow:0 60px 120px -40px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,.03) inset; overflow:hidden; text-align:left; transform-origin:50% 0; }
.lp .hw-bar { display:flex; align-items:center; gap:8px; padding:12px 16px; background:#232327; border-bottom:1px solid #2c2c31; }
.lp .hw-bar > i { width:11px; height:11px; border-radius:50%; background:#3a3a40; }
.lp .hw-bar .url { margin:0 auto; display:inline-flex; align-items:center; gap:8px; font-size:12.5px; color:#bdb9ae; background:#17171a; border-radius:99px; padding:5px 16px; }
.lp .hw-bar .ext { width:22px; height:22px; border-radius:6px; background:var(--hl); display:grid; place-items:center; }
.lp .hw-body { display:grid; grid-template-columns:1fr 350px; min-height:470px; }
.lp .call { position:relative; background:#202124; padding:16px 16px 74px; display:flex; flex-direction:column; }
.lp .call .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:10px; }
.lp .vt { position:relative; border-radius:12px; background:#2e3034; display:grid; place-items:center; overflow:hidden; min-height:110px; }
.lp .vav { width:64px; height:64px; border-radius:50%; display:grid; place-items:center; font-size:26px; font-weight:700; color:#fff; }
.lp .vt .tag { position:absolute; left:10px; bottom:8px; font-size:12px; font-weight:600; letter-spacing:0; text-transform:none; color:#fff; background:rgba(0,0,0,.45); padding:1px 8px; border-radius:6px; }
.lp .ring { position:absolute; inset:0; border-radius:12px; border:3px solid #3ddc84; opacity:0; }
.lp .caps { position:absolute; left:16px; right:16px; bottom:62px; min-height:50px; }
.lp .capline { position:absolute; left:0; right:0; bottom:0; display:flex; gap:10px; align-items:flex-start; background:rgba(20,20,22,.92); border-radius:10px; padding:9px 12px; font-size:14px; line-height:1.35; }
.lp .capline b { display:block; font-size:11.5px; color:#cfcbc0; }
.lp .tools { position:absolute; left:0; right:0; bottom:0; height:56px; display:flex; justify-content:center; align-items:center; gap:12px; }
.lp .tools i { width:38px; height:38px; border-radius:50%; background:#3c4043; display:grid; place-items:center; font-style:normal; }
.lp .tools .cc { font-size:11px; font-weight:800; background:#a8c7fa; color:#062e6f; }
.lp .tools .end { width:54px; border-radius:20px; background:#d93025; }
.lp .side { background:#0f0f11; border-left:1px solid #2c2c31; display:flex; flex-direction:column; }
.lp .sh { display:flex; gap:10px; align-items:center; padding:14px 14px 10px; }
.lp .sh .logo { width:28px; height:28px; border-radius:8px; background:var(--hl); display:grid; place-items:center; flex:none; }
.lp .sh b { display:block; font-size:13px; line-height:1.2; } .lp .sh small { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:11.5px; }
.lp .live { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--green); animation:lpPulse 1.8s infinite; }
@keyframes lpPulse { 70% { box-shadow:0 0 0 8px rgba(61,220,132,0); } 0% { box-shadow:0 0 0 0 rgba(61,220,132,.55); } }
.lp .stabs { display:flex; gap:2px; margin:0 12px; padding:3px; border-radius:10px; background:#1b1b1e; }
.lp .stabs span { flex:1; text-align:center; font-size:10.5px; font-weight:650; color:#7d796f; padding:6px 0; border-radius:7px; position:relative; transition:background .3s,color .3s; }
.lp .stabs span.on { background:#2a2a2f; color:var(--hl); }
.lp .stabs em { position:absolute; top:-3px; right:5px; font-style:normal; background:var(--hl); color:#111; border-radius:99px; font-size:9px; padding:0 5px; line-height:14px; font-weight:800; }
.lp .sbody { position:relative; flex:1; padding:12px; }
.lp .pview { position:absolute; inset:12px; display:flex; flex-direction:column; gap:8px; }
.lp .pl { display:flex; gap:9px; padding:6px; font-size:12.5px; line-height:1.4; color:#dedacd; } .lp .pl b { display:block; font-size:11.5px; color:#fff; }
.lp .ic { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#161618; font-size:13px; }
.lp .ic b { display:block; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); } .lp .ic span { font-weight:600; }
.lp .ic .cb { color:#8c887d; flex:none; margin-top:2px; }
.lp .av { display:inline-grid; place-items:center; border-radius:50%; color:#fff; font-weight:750; flex:none; }
@media (max-width:860px) { .lp .hw-body { grid-template-columns:1fr; } .lp .call { display:none; } .lp .side { border:0; min-height:360px; } }

/* marquee rows */
.lp .strip { padding:40px 0 20px; overflow:hidden; }
.lp .strip .cap2 { text-align:center; margin-bottom:26px; }
.lp .mrow { display:flex; width:max-content; gap:54px; margin-bottom:22px; will-change:transform; }
.lp .mitem { display:flex; align-items:center; gap:14px; font-weight:680; font-size:20px; letter-spacing:-.02em; white-space:nowrap; color:#dad6ca; }
.lp .mitem .tile { transition:transform .3s; } .lp .mitem:hover .tile { transform:rotate(-8deg) scale(1.08); }

/* the hero diagram */
.lp .field { position:relative; width:min(1180px,100%); aspect-ratio:1180/560; margin:34px auto 0; text-align:left; }
.lp .fglow { position:absolute; left:50%; top:53%; width:78%; aspect-ratio:1; transform:translate(-50%,-50%); background:radial-gradient(closest-side, rgba(61,220,132,.20), rgba(61,220,132,.05) 55%, transparent 72%); pointer-events:none; }
.lp .fsvg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
.lp .rings circle { fill:none; stroke:rgba(61,220,132,.22); stroke-width:1.2; transform-origin:590px 300px; }
.lp .fline { fill:none; stroke:#5d6b62; stroke-width:1.4; stroke-dasharray:3 7; animation:lpFlow 1.8s linear infinite; }
@keyframes lpFlow { to { stroke-dashoffset:-20; } }
.lp .core { position:absolute; width:min(19%,200px); aspect-ratio:1; transform:translate(-50%,-50%); border-radius:50%; background:radial-gradient(circle at 50% 40%, #12241a, #0a120d 70%); border:1.5px solid rgba(61,220,132,.55); box-shadow:0 0 60px rgba(61,220,132,.35), inset 0 0 40px rgba(61,220,132,.12); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; }
.lp .ctag { font:600 10px "JetBrains Mono", monospace; letter-spacing:.3em; color:#9bb7a6; }
.lp .cname { font:600 13px "JetBrains Mono", monospace; letter-spacing:.12em; color:#9bb7a6; }
.lp .spoke { position:absolute; display:inline-flex; align-items:center; gap:8px; font:600 12px "JetBrains Mono", monospace; letter-spacing:.2em; color:#c9d3cc; white-space:nowrap; } .lp .spoke i { color:var(--green); display:inline-grid; }
.lp .chip { position:absolute; display:inline-flex; align-items:center; gap:9px; padding:7px 14px; border-radius:99px; background:#0f1310; border:1px solid #26322a; font:500 12.5px "JetBrains Mono", monospace; color:#d8e2db; white-space:nowrap; will-change:transform; }
.lp .chip i { width:9px; height:9px; border-radius:50%; flex:none; }
.lp .ticker { position:absolute; width:34%; overflow:hidden; font:500 13px "JetBrains Mono", monospace; color:#c9d3cc; -webkit-mask-image:linear-gradient(90deg, transparent, #000 10%, #000 85%, transparent); mask-image:linear-gradient(90deg, transparent, #000 10%, #000 85%, transparent); }
.lp .ttrack { display:flex; width:max-content; gap:28px; white-space:nowrap; will-change:transform; } .lp .ttrack b { color:var(--green); font-weight:600; } .lp .ttrack em { color:#5d6b62; font-style:normal; margin-left:28px; }
.lp .fcard { position:absolute; width:min(20%,230px); padding:14px 16px 12px; border-radius:12px; background:rgba(15,19,16,.78); border:1px solid #1f2923; font:500 12px "JetBrains Mono", monospace; color:#7f8c84; transition:border-color .4s, color .4s; }
.lp .fcard.hot { border-color:rgba(61,220,132,.45); color:#cfd9d2; }
.lp .fh { display:flex; align-items:center; gap:9px; margin-bottom:10px; letter-spacing:.14em; font-size:10.5px; color:#9aa79f; } .lp .fh i { font-style:normal; border:1px solid #2a352e; border-radius:5px; padding:1px 6px; color:#6f7c74; }
.lp .fi { display:flex; align-items:center; gap:10px; padding:6px 0; } .lp .fi u { width:6px; height:6px; border-radius:50%; background:#2e6b47; flex:none; } .lp .fcard.hot .fi u { background:var(--green); }
.lp .ftile { position:absolute; transform:translate(-50%,-50%); }
.lp .pillb { display:inline-flex; align-items:center; gap:10px; padding:6px 16px 6px 8px; border:1px solid #34343a; border-radius:99px; background:rgba(255,255,255,.04); font-size:14.5px; font-weight:560; }
.lp .pillb b { background:var(--hl); color:#111; border-radius:99px; padding:1px 9px; font-size:12.5px; font-weight:800; }
.lp .platforms { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 30px; margin-top:34px; font:600 12px "JetBrains Mono", monospace; letter-spacing:.14em; color:#9a968b; } .lp .platforms span { display:inline-flex; align-items:center; gap:9px; }
@media (max-width:900px) {
  .lp .field { aspect-ratio:auto; height:430px; }
  .lp .fcard, .lp .ticker, .lp .spoke, .lp .fsvg { display:none; }
  .lp .chip { font-size:11px; padding:6px 11px; }
  .lp .core { width:150px; top:44% !important; }
  .lp .fglow { width:150%; top:44%; }
  .lp .ftile { top:86% !important; }
  .lp .ftile:nth-last-child(4) { left:calc(50% - 114px) !important; } .lp .ftile:nth-last-child(3) { left:calc(50% - 38px) !important; }
  .lp .ftile:nth-last-child(2) { left:calc(50% + 38px) !important; } .lp .ftile:nth-last-child(1) { left:calc(50% + 114px) !important; }
  .lp .chip:nth-of-type(odd) { margin-top:-8px; }
}

/* feature rows */
.lp .frow { display:grid; grid-template-columns:1fr 1fr; gap:64px; align-items:center; margin-top:110px; }
.lp .frow:first-of-type { margin-top:70px; }
.lp .frow.flip .ftxt { order:2; }
.lp .ftxt h3 { font-size:clamp(28px,3.2vw,44px); letter-spacing:-.035em; line-height:1.06; font-weight:750; margin-top:14px; }
.lp .ftxt p { color:var(--mut); margin-top:16px; max-width:460px; }
.lp .ftxt .tlink { margin-top:22px; }
.lp .mock { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:20px; box-shadow:0 40px 80px -50px rgba(0,0,0,.9); position:relative; overflow:hidden; min-height:260px; }
.lp .mwin { display:flex; align-items:center; gap:9px; font-weight:700; font-size:14px; padding-bottom:12px; border-bottom:1px solid var(--line); margin-bottom:14px; }
.lp .cc { margin-left:auto; font-size:10px; font-weight:800; border:1.5px solid var(--mut); border-radius:5px; padding:0 5px; color:var(--mut); }
.lp .cap { display:flex; gap:11px; align-items:flex-start; font-size:14.5px; margin-bottom:13px; line-height:1.4; } .lp .cap b { display:block; font-size:12px; color:#cfcbc0; }
.lp .m2 .row .cb { color:#8c887d; } .lp .m2 .row .who { color:var(--mut); }
.lp .cand { display:flex; align-items:center; gap:12px; padding:13px; border-radius:14px; background:var(--card2); border:1px solid var(--line); margin-top:12px; }
.lp .cand.dim { opacity:.5; }
.lp .cand .nm { font-weight:700; font-size:15px; line-height:1.2; } .lp .cand .why { font-size:12.5px; color:var(--mut); }
.lp .assign { margin-left:auto; border:0; background:var(--hl); color:#111; font-weight:750; font-size:13px; padding:7px 15px; border-radius:99px; transition:background .2s,color .2s; }
.lp .assign.done { background:var(--green); }
.lp .pill { display:inline-block; font-size:11px; font-weight:700; padding:1px 9px; border-radius:99px; background:rgba(61,220,132,.14); color:var(--green); margin-top:5px; }
@media (max-width:940px) { .lp .frow { grid-template-columns:1fr; gap:34px; margin-top:80px; } .lp .frow.flip .ftxt { order:0; } }

/* statement + sticky notes */
.lp .statement { text-align:center; }
.lp .statement h2 { max-width:900px; margin-inline:auto; }
.lp .board { position:relative; height:470px; max-width:860px; margin:70px auto 0; }
.lp .sticky { position:absolute; width:min(236px, 31%); padding:18px 16px 14px; background:#fff0a0; color:#2c2606; box-shadow:0 24px 30px -18px rgba(0,0,0,.9); font-weight:680; line-height:1.3; font-size:16px; text-align:left; }
.lp .sticky .q { display:block; margin-top:8px; font-weight:500; font-size:12.5px; color:#6b5a14; font-style:italic; }
.lp .sticky.no .q { color:#9b3b3b; }
.lp .sticky .tick { position:absolute; right:10px; top:8px; }
.lp .sticky .scrib { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.lp .stamp { position:absolute; right:-6px; bottom:-14px; font-size:12px; font-weight:800; letter-spacing:.08em; color:var(--red); border:3px solid var(--red); border-radius:7px; padding:2px 9px; background:#1a0d0d; transform:rotate(-8deg); }
.lp .tally { display:flex; justify-content:center; gap:44px; margin-top:34px; }
.lp .tally div { font-size:14px; color:var(--mut); } .lp .tally b { display:block; font-size:38px; line-height:1; letter-spacing:-.04em; color:var(--fg); }
.lp .replay { margin-top:20px; background:none; border:0; color:var(--mut); font-weight:650; cursor:pointer; text-decoration:underline; text-underline-offset:4px; }
.lp .replay:hover { color:var(--hl); }
@media (max-width:760px) { .lp .board { height:560px; } .lp .sticky { width:min(236px,46%); } }

/* bento */
.lp .bento { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; margin-top:54px; }
.lp .bc { background:var(--card); border:1px solid var(--line); border-radius:24px; padding:26px; overflow:hidden; display:flex; flex-direction:column; gap:18px; min-height:330px; }
.lp .bc .t b { display:block; font-size:19px; letter-spacing:-.025em; } .lp .bc .t span { color:var(--mut); font-size:14.5px; }
.lp .bc .mock { background:var(--card2); box-shadow:none; flex:1; min-height:0; padding:16px; }
.lp .c7 { grid-column:span 7; } .lp .c5 { grid-column:span 5; } .lp .c4 { grid-column:span 4; }
.lp .chat .msg { display:flex; gap:11px; align-items:flex-start; margin-bottom:14px; font-size:14.5px; } .lp .chat .msg .t b { display:block; font-size:12.5px; color:#cfcbc0; margin-bottom:1px; }
.lp .bot { width:28px; height:28px; border-radius:8px; background:var(--hl); display:grid; place-items:center; flex:none; }
.lp .src { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; } .lp .src span { font-size:11.5px; font-weight:650; padding:3px 10px; border-radius:99px; background:#2a2a2f; }
.lp .think { display:inline-flex; gap:5px; padding:6px 0; } .lp .think i { width:6px; height:6px; border-radius:50%; background:var(--mut); }
.lp .toasts { display:flex; flex-direction:column; gap:10px; flex:1; justify-content:center; }
.lp .toast { display:flex; gap:12px; align-items:flex-start; background:var(--card2); border:1px solid var(--line); border-radius:14px; padding:12px 14px; font-size:13.5px; }
.lp .toast b { display:block; font-size:13.5px; } .lp .toast span { color:var(--mut); font-size:12.5px; display:block; }
.lp .ti { width:28px; height:28px; border-radius:8px; background:var(--hl); display:grid; place-items:center; flex:none; font-weight:800; color:#111; } .lp .ti.g { background:var(--green); color:#04210f; } .lp .ti.y { background:var(--amber); }
.lp .toast em { display:flex; gap:12px; margin-top:7px; font-style:normal; } .lp .toast u { text-decoration:none; font-size:12px; font-weight:700; padding:3px 11px; border-radius:99px; border:1px solid #3a3a40; }
.lp .owners .orow { display:flex; align-items:center; gap:12px; padding:9px 8px; border-radius:11px; position:relative; transition:background .3s; font-size:14px; }
.lp .owners .orow b { display:block; line-height:1.2; } .lp .owners .orow span { font-size:12px; color:var(--mut); }
.lp .owners .orow.on { background:#2a2a2f; } .lp .pick { margin-left:auto; width:18px; height:18px; border-radius:50%; border:2px solid #4a4a50; } .lp .orow.on .pick { background:var(--green); border-color:var(--green); }
.lp .tools3 { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; place-items:center; flex:1; align-content:center; }
.lp .exp .erow { display:flex; justify-content:space-between; align-items:center; padding:10px 8px; border-radius:10px; font-size:14px; font-weight:600; transition:background .3s; } .lp .exp .erow.on { background:#2a2a2f; color:var(--hl); }
@media (max-width:940px) { .lp .c7, .lp .c5, .lp .c4 { grid-column:span 12; } }
@media (min-width:941px) and (max-width:1100px) { .lp .c4 { grid-column:span 6; } }

/* security */
.lp .sec2 { display:grid; grid-template-columns:1fr 1fr; gap:60px; align-items:start; }
.lp .checks { list-style:none; padding:0; margin:30px 0 0; display:flex; flex-direction:column; gap:14px; }
.lp .checks li { display:flex; gap:12px; align-items:flex-start; font-size:16.5px; } .lp .checks svg { color:var(--hl); flex:none; margin-top:3px; }
.lp .prows { display:flex; flex-direction:column; gap:10px; margin-top:34px; }
.lp .prow { display:flex; gap:14px; align-items:center; padding:14px 16px; background:var(--card); border:1px solid var(--line); border-radius:16px; }
.lp .prow .pi { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; background:var(--card2); flex:none; color:var(--hl); }
.lp .prow b { display:block; font-size:16px; letter-spacing:-.02em; } .lp .prow span { font-size:14px; color:var(--mut); }
.lp .log { background:var(--card); border:1px solid var(--line); border-radius:22px; padding:6px 6px 10px; box-shadow:0 40px 80px -50px rgba(0,0,0,.9); }
.lp .lh { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; font-size:12.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--mut); }
.lp .lrow { display:flex; align-items:center; gap:12px; padding:13px 16px; border-top:1px solid var(--line); font-size:14.5px; }
.lp .lic { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; flex:none; font-weight:800; font-size:13px; }
.lp .lrow.ok .lic { background:rgba(61,220,132,.16); color:var(--green); } .lp .lrow.no .lic { background:rgba(255,107,107,.16); color:var(--red); } .lp .lrow.warn .lic { background:rgba(255,184,77,.16); color:var(--amber); }
.lp .lrow .ts { margin-left:auto; font-size:11.5px; color:#77736a; white-space:nowrap; }
@media (max-width:940px) { .lp .sec2 { grid-template-columns:1fr; } }

/* faq */
.lp .faq { max-width:820px; margin:48px auto 0; border-top:1px solid var(--line); }
.lp .qa { border-bottom:1px solid var(--line); }
.lp .qa .q { width:100%; display:flex; justify-content:space-between; align-items:center; gap:20px; text-align:left; background:none; border:0; color:var(--fg); padding:26px 4px; font-size:clamp(18px,2vw,22px); font-weight:650; letter-spacing:-.02em; cursor:pointer; }
.lp .qa .pm { position:relative; width:20px; height:20px; flex:none; } .lp .qa .pm::before, .lp .qa .pm::after { content:""; position:absolute; left:0; top:9px; width:20px; height:2px; background:var(--fg); transition:transform .35s; } .lp .qa .pm::after { transform:rotate(90deg); }
.lp .qa.open .pm::after { transform:rotate(0); }
.lp .qa .a { height:0; overflow:hidden; } .lp .qa .a p { color:var(--mut); padding:0 4px 26px; max-width:700px; }

/* closing */
.lp .cta { text-align:center; padding:120px 0 110px; position:relative; border-top:1px solid var(--line); overflow:hidden; }
.lp .cta::before { content:""; position:absolute; left:50%; top:30%; width:900px; height:560px; transform:translateX(-50%); background:radial-gradient(closest-side, rgba(255,225,77,.10), transparent); pointer-events:none; }
.lp .cta h2 { font-size:clamp(44px, 8.4vw, 120px); line-height:.97; letter-spacing:-.05em; font-weight:790; position:relative; }
.lp .cta p { color:var(--mut); margin:26px auto 0; max-width:520px; position:relative; }
.lp .cta .ctas { position:relative; } .lp .cta .works { position:relative; }
.lp footer.foot { border-top:1px solid var(--line); padding:54px 0 40px; font-size:14.5px; color:var(--mut); }
.lp .fgrid { display:grid; grid-template-columns:1.4fr repeat(3,1fr); gap:30px; } .lp .fgrid b { display:block; color:var(--fg); margin-bottom:12px; font-size:14px; } .lp .fgrid a { display:block; padding:3px 0; } .lp .fgrid a:hover { color:var(--fg); }
.lp .legal { margin-top:40px; padding-top:20px; border-top:1px solid var(--line); font-size:13px; color:#77736a; }
@media (max-width:760px) { .lp .fgrid { grid-template-columns:1fr 1fr; } }

.lp .lm { display:block; overflow:hidden; padding-bottom:.12em; margin-bottom:-.08em; }
.lp .li { display:block; }
.lp .own { position:relative; display:inline-block; }
.lp .own .squig { position:absolute; left:0; right:0; bottom:-.12em; width:100%; height:.32em; transform:none; overflow:visible; }
.lp .ty, .lp .ct, .lp .q1, .lp .a1 { display:block; }
.lp .pl > div, .lp .ic > div { flex:1; min-width:0; } .lp .pl span:not(.av), .lp .ic span { display:block; }
.lp .hero .fine { margin-top:26px; }
.lp .cta .it { color:var(--hl); }
@media (prefers-reduced-motion:reduce) { .lp *, .lp *::before, .lp *::after { animation:none !important; transition:none !important; } }
`
