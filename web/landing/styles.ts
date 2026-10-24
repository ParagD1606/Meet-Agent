// Landing page styles. Scoped under .lp so nothing leaks into the app. White, near-black, sharp — tuned to feel like onyx.app.
export const css = String.raw`
.lp { --bg:#ffffff; --surface:#fafafa; --card:#ffffff; --card2:#fafafa; --line:#e6e6e6; --line-soft:#efefef; --fg:#1c1c1e; --mut:rgba(0,0,0,0.55); --mut-2:rgba(0,0,0,0.40); --hl:#286df8; --green:#16a34a; --red:#dc2626; --amber:#d97706; --paper:#ffffff; --ink:#1c1c1e; --btn-fg:#ffffff; --btn-bg:#1c1c1c;
  background:var(--bg); color:var(--fg); min-height:100dvh; overflow-x:clip; font-size:16px; line-height:1.55; letter-spacing:-.01em; color-scheme:light;
  font-family:"Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
.lp *, .lp *::before, .lp *::after { box-sizing:border-box; }
.lp a { color:inherit; text-decoration:none; }
.lp h1, .lp h2, .lp h3, .lp p { margin:0; }
.lp button { font:inherit; }
.lp ::selection { background:var(--hl); color:#fff; }
.lp .wrap { width:min(1180px, 100% - 48px); margin-inline:auto; }
.lp .mono { font-family:"DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.lp .sec { padding:120px 0; position:relative; }
.lp .tag { font-size:12px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); font-family:"DM Mono", ui-monospace, monospace; }
.lp h2.big { font-size:clamp(34px, 4.8vw, 64px); line-height:1.03; letter-spacing:-.04em; font-weight:700; color:var(--fg); }
.lp .lead { color:var(--mut); font-size:clamp(17px,1.5vw,20px); max-width:560px; margin-top:20px; line-height:1.5; }
.lp .it { font-family:"Instrument Serif", ui-serif, Georgia, "Times New Roman", serif; font-style:italic; font-weight:400; letter-spacing:-.02em; font-size:1.1em; color:var(--fg); }
.lp .hl { position:relative; z-index:0; white-space:nowrap; color:var(--fg); }
.lp .hl::before { content:""; position:absolute; left:-.04em; right:-.04em; bottom:0; height:2px; background:var(--hl); z-index:-1; transform-origin:0 50%; transform:scaleX(var(--s,1)); }

/* nav */
.lp .nav { position:sticky; top:0; z-index:50; border-bottom:1px solid transparent; transition:background .3s, border-color .3s, backdrop-filter .3s; }
.lp .nav.scrolled { background:rgba(255,255,255,.72); backdrop-filter:saturate(1.4) blur(14px); -webkit-backdrop-filter:saturate(1.4) blur(14px); border-color:var(--line); }
.lp .nav .wrap { display:flex; align-items:center; gap:30px; height:72px; }
.lp .brand { display:flex; align-items:center; gap:10px; font-weight:500; letter-spacing:-.02em; font-size:17px; white-space:nowrap; color:var(--fg); }
.lp .brand i { width:26px; height:26px; background:var(--fg); display:grid; place-items:center; }
.lp .nav .links { display:flex; gap:28px; font-size:14px; font-weight:500; color:var(--mut); margin-left:14px; }
.lp .nav .links a:hover { color:var(--fg); }
.lp .nav .right { margin-left:auto; display:flex; align-items:center; gap:18px; font-size:14px; font-weight:500; }
@media (max-width:820px) { .lp .nav .links, .lp .nav .plain { display:none; } }

/* buttons: flat, sharp corners, Onyx-style */
.lp .btn { display:inline-flex; align-items:center; gap:10px; height:44px; padding:0 20px; border-radius:0; font-weight:500; font-size:14px; cursor:pointer; border:1px solid transparent; transition:background .18s ease, color .18s ease, border-color .18s ease; }
.lp .btn.pri { background:var(--btn-bg); color:var(--btn-fg); border-color:var(--btn-bg); }
.lp .btn.pri:hover { background:#000; border-color:#000; }
.lp .btn.ghost { border-color:var(--fg); color:var(--fg); background:#fff; }
.lp .btn.ghost:hover { background:var(--surface); }
.lp .btn.sm { height:38px; padding:0 14px; font-size:13.5px; }
.lp .btn .roll { display:inline-block; position:relative; height:1.3em; overflow:hidden; line-height:1.3; }
.lp .btn .roll span { display:block; transition:transform .38s cubic-bezier(.7,0,.2,1); }
.lp .btn .roll span + span { position:absolute; left:0; top:100%; }
.lp .btn:hover .roll span { transform:translateY(-100%); }
.lp .tlink { display:inline-flex; align-items:center; gap:8px; font-weight:500; color:var(--fg); border-bottom:1px solid var(--fg); padding-bottom:2px; }
.lp .tlink:hover { color:var(--mut); border-color:var(--mut); }

/* hero */
.lp .hero { position:relative; text-align:center; padding:60px 0 30px; }
.lp .hero::before { content:""; position:absolute; left:50%; top:-80px; width:980px; height:720px; transform:translateX(-50%); background:radial-gradient(closest-side, rgba(40,109,248,.05), transparent); pointer-events:none; }
.lp .h1 { font-size:clamp(44px, 6.8vw, 100px); line-height:.98; letter-spacing:-.045em; font-weight:700; position:relative; margin-top:26px; color:var(--fg); }
.lp .h1 .ln { padding-bottom:.1em; }
.lp .hero .sub { margin:28px auto 0; font-size:clamp(16px,1.4vw,18px); color:var(--mut); max-width:620px; line-height:1.5; }
.lp .bul { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 30px; list-style:none; padding:0; margin:30px 0 0; font-size:14.5px; font-weight:500; color:var(--fg); }
.lp .bul li { display:inline-flex; align-items:center; gap:9px; } .lp .bul svg { color:var(--fg); flex:none; }
.lp .ctas { display:flex; flex-wrap:wrap; justify-content:center; gap:12px; margin-top:34px; }
.lp .fine { margin-top:20px; font-size:13.5px; color:var(--mut); }
.lp .works { display:flex; align-items:center; justify-content:center; gap:16px; margin-top:34px; font-size:13px; color:var(--mut); font-weight:500; }
.lp .tile { display:inline-grid; place-items:center; border-radius:14%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.04), 0 0 0 1px var(--line); }

/* the big product preview */
.lp .hwrap { margin-top:54px; perspective:1600px; }
.lp .hw { max-width:1060px; margin-inline:auto; border-radius:0; background:#fff; border:1px solid var(--line); box-shadow:0 20px 60px -30px rgba(0,0,0,.12); overflow:hidden; text-align:left; transform-origin:50% 0; }
.lp .hw-bar { display:flex; align-items:center; gap:8px; padding:12px 16px; background:var(--surface); border-bottom:1px solid var(--line); }
.lp .hw-bar > i { width:11px; height:11px; border-radius:50%; background:var(--line); }
.lp .hw-bar .url { margin:0 auto; display:inline-flex; align-items:center; gap:8px; font-size:12.5px; color:var(--mut); background:#fff; border:1px solid var(--line); border-radius:0; padding:5px 16px; }
.lp .hw-bar .ext { width:22px; height:22px; background:var(--fg); display:grid; place-items:center; }
.lp .hw-body { display:grid; grid-template-columns:1fr 350px; min-height:470px; background:#fff; }
.lp .call { position:relative; background:var(--surface); padding:16px 16px 74px; display:flex; flex-direction:column; }
.lp .call .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:10px; }
.lp .vt { position:relative; border-radius:0; background:#fff; border:1px solid var(--line); display:grid; place-items:center; overflow:hidden; min-height:110px; }
.lp .vav { width:64px; height:64px; border-radius:50%; display:grid; place-items:center; font-size:26px; font-weight:600; color:#fff; }
.lp .vt .tag { position:absolute; left:10px; bottom:8px; font-size:12px; font-weight:500; letter-spacing:0; text-transform:none; color:#fff; background:rgba(0,0,0,.55); padding:1px 8px; border-radius:0; font-family:inherit; }
.lp .ring { position:absolute; inset:0; border-radius:0; border:2px solid var(--green); opacity:0; }
.lp .caps { position:absolute; left:16px; right:16px; bottom:62px; min-height:50px; }
.lp .capline { position:absolute; left:0; right:0; bottom:0; display:flex; gap:10px; align-items:flex-start; background:#fff; border:1px solid var(--line); border-radius:0; padding:9px 12px; font-size:13.5px; line-height:1.35; color:var(--fg); }
.lp .capline b { display:block; font-size:11.5px; color:var(--mut); font-weight:500; }
.lp .tools { position:absolute; left:0; right:0; bottom:0; height:56px; display:flex; justify-content:center; align-items:center; gap:12px; }
.lp .tools i { width:38px; height:38px; border-radius:50%; background:#fff; border:1px solid var(--line); display:grid; place-items:center; font-style:normal; }
.lp .tools .cc { font-size:11px; font-weight:600; background:#dbeafe; border-color:#dbeafe; color:#1e40af; }
.lp .tools .end { width:54px; border-radius:999px; background:#dc2626; border-color:#dc2626; }
.lp .side { background:#fff; border-left:1px solid var(--line); display:flex; flex-direction:column; }
.lp .sh { display:flex; gap:10px; align-items:center; padding:14px 14px 10px; }
.lp .sh .logo { width:26px; height:26px; background:var(--fg); display:grid; place-items:center; flex:none; }
.lp .sh b { display:block; font-size:13px; line-height:1.2; color:var(--fg); font-weight:500; } .lp .sh small { display:flex; align-items:center; gap:6px; color:var(--mut); font-size:11.5px; }
.lp .live { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--green); animation:lpPulse 1.8s infinite; }
@keyframes lpPulse { 70% { box-shadow:0 0 0 8px rgba(22,163,74,0); } 0% { box-shadow:0 0 0 0 rgba(22,163,74,.55); } }
.lp .stabs { display:flex; gap:2px; margin:0 12px; padding:3px; border:1px solid var(--line); background:var(--surface); }
.lp .stabs span { flex:1; text-align:center; font-size:10.5px; font-weight:500; color:var(--mut); padding:6px 0; border-radius:0; position:relative; transition:background .3s,color .3s; letter-spacing:.04em; text-transform:uppercase; font-family:"DM Mono", ui-monospace, monospace; }
.lp .stabs span.on { background:#fff; color:var(--fg); box-shadow:inset 0 0 0 1px var(--line); }
.lp .stabs em { position:absolute; top:-3px; right:5px; font-style:normal; background:var(--fg); color:#fff; border-radius:0; font-size:9px; padding:0 5px; line-height:14px; font-weight:600; font-family:"Hanken Grotesk", sans-serif; }
.lp .sbody { position:relative; flex:1; padding:12px; }
.lp .pview { position:absolute; inset:12px; display:flex; flex-direction:column; gap:8px; }
.lp .pl { display:flex; gap:9px; padding:6px; font-size:13px; line-height:1.4; color:var(--fg); } .lp .pl b { display:block; font-size:11.5px; color:var(--mut); font-weight:500; }
.lp .ic { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--line); border-radius:0; padding:10px 12px; background:#fff; font-size:13px; color:var(--fg); }
.lp .ic b { display:block; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--mut); font-weight:500; font-family:"DM Mono", ui-monospace, monospace; } .lp .ic span { font-weight:500; }
.lp .ic .cb { color:var(--mut); flex:none; margin-top:2px; }
.lp .av { display:inline-grid; place-items:center; border-radius:50%; color:#fff; font-weight:600; flex:none; }
@media (max-width:860px) { .lp .hw-body { grid-template-columns:1fr; } .lp .call { display:none; } .lp .side { border:0; min-height:360px; } }

/* marquee rows */
.lp .strip { padding:40px 0 20px; overflow:hidden; }
.lp .strip .cap2 { text-align:center; margin-bottom:26px; }
.lp .mrow { display:flex; width:max-content; gap:54px; margin-bottom:22px; will-change:transform; }
.lp .mitem { display:flex; align-items:center; gap:14px; font-weight:500; font-size:18px; letter-spacing:-.015em; white-space:nowrap; color:var(--fg); }
.lp .mitem .tile { transition:transform .3s; } .lp .mitem:hover .tile { transform:rotate(-6deg) scale(1.06); }

/* the hero diagram */
.lp .field { position:relative; width:min(1180px,100%); aspect-ratio:1180/560; margin:34px auto 0; text-align:left;
  background-image: linear-gradient(var(--line-soft) 1px, transparent 1px), linear-gradient(90deg, var(--line-soft) 1px, transparent 1px); background-size:40px 40px; background-position:center;
  -webkit-mask-image:radial-gradient(ellipse at center, #000 55%, transparent 85%); mask-image:radial-gradient(ellipse at center, #000 55%, transparent 85%); }
.lp .fglow { position:absolute; left:50%; top:53%; width:78%; aspect-ratio:1; transform:translate(-50%,-50%); background:radial-gradient(closest-side, rgba(40,109,248,.08), rgba(40,109,248,.02) 55%, transparent 72%); pointer-events:none; }
.lp .fsvg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
.lp .rings circle { fill:none; stroke:rgba(40,109,248,.22); stroke-width:1.2; transform-origin:590px 300px; }
.lp .fline { fill:none; stroke:var(--mut-2); stroke-width:1.2; stroke-dasharray:3 7; animation:lpFlow 1.8s linear infinite; }
@keyframes lpFlow { to { stroke-dashoffset:-20; } }
.lp .core { position:absolute; width:min(19%,200px); aspect-ratio:1; transform:translate(-50%,-50%); border-radius:50%; background:#fff; border:1px solid var(--line); box-shadow:0 10px 40px rgba(40,109,248,.10), 0 1px 2px rgba(0,0,0,.04); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; }
.lp .ctag { font:500 10px "DM Mono", monospace; letter-spacing:.3em; color:var(--mut); }
.lp .cname { font:500 13px "DM Mono", monospace; letter-spacing:.12em; color:var(--fg); }
.lp .spoke { position:absolute; display:inline-flex; align-items:center; gap:8px; font:500 11px "DM Mono", monospace; letter-spacing:.2em; color:var(--mut); white-space:nowrap; text-transform:uppercase; } .lp .spoke i { color:var(--green); display:inline-grid; }
.lp .chip { position:absolute; display:inline-flex; align-items:center; gap:9px; padding:7px 14px; border-radius:0; background:#fff; border:1px solid var(--line); font:500 12px "DM Mono", monospace; color:var(--fg); white-space:nowrap; will-change:transform; box-shadow:0 1px 2px rgba(0,0,0,.03); }
.lp .chip i { width:9px; height:9px; border-radius:50%; flex:none; }
.lp .ticker { position:absolute; width:34%; overflow:hidden; font:500 12.5px "DM Mono", monospace; color:var(--mut); -webkit-mask-image:linear-gradient(90deg, transparent, #000 10%, #000 85%, transparent); mask-image:linear-gradient(90deg, transparent, #000 10%, #000 85%, transparent); }
.lp .ttrack { display:flex; width:max-content; gap:28px; white-space:nowrap; will-change:transform; } .lp .ttrack b { color:var(--fg); font-weight:500; } .lp .ttrack em { color:var(--mut-2); font-style:normal; margin-left:28px; }
.lp .fcard { position:absolute; width:min(20%,230px); padding:14px 16px 12px; border-radius:0; background:#fff; border:1px solid var(--line); font:500 12px "DM Mono", monospace; color:var(--mut); transition:border-color .4s, color .4s; box-shadow:0 1px 2px rgba(0,0,0,.03); }
.lp .fcard.hot { border-color:var(--fg); color:var(--fg); box-shadow:0 6px 24px rgba(0,0,0,.08); }
.lp .fh { display:flex; align-items:center; gap:9px; margin-bottom:10px; letter-spacing:.14em; font-size:10px; color:var(--mut); } .lp .fh i { font-style:normal; border:1px solid var(--line); border-radius:0; padding:1px 6px; color:var(--mut); }
.lp .fi { display:flex; align-items:center; gap:10px; padding:6px 0; } .lp .fi u { width:6px; height:6px; border-radius:50%; background:var(--line); flex:none; } .lp .fcard.hot .fi u { background:var(--green); }
.lp .ftile { position:absolute; transform:translate(-50%,-50%); }
.lp .pillb { display:inline-flex; align-items:center; gap:10px; padding:6px 16px 6px 8px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:13px; font-weight:500; color:var(--fg); }
.lp .pillb b { background:var(--fg); color:#fff; border-radius:999px; padding:1px 9px; font-size:11.5px; font-weight:500; }
.lp .platforms { display:flex; flex-wrap:wrap; justify-content:center; gap:10px 30px; margin-top:34px; font:500 11px "DM Mono", monospace; letter-spacing:.14em; color:var(--mut); } .lp .platforms span { display:inline-flex; align-items:center; gap:9px; }
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
.lp .ftxt h3 { font-size:clamp(28px,3.2vw,44px); letter-spacing:-.035em; line-height:1.06; font-weight:700; margin-top:14px; color:var(--fg); }
.lp .ftxt p { color:var(--mut); margin-top:16px; max-width:460px; line-height:1.5; font-size:16px; }
.lp .ftxt .tlink { margin-top:22px; }
.lp .mock { background:#fff; border:1px solid var(--line); border-radius:0; padding:20px; box-shadow:0 1px 2px rgba(0,0,0,.04); position:relative; overflow:hidden; min-height:260px; color:var(--fg); }
.lp .mwin { display:flex; align-items:center; gap:9px; font-weight:500; font-size:14px; padding-bottom:12px; border-bottom:1px solid var(--line); margin-bottom:14px; color:var(--fg); }
.lp .cc { margin-left:auto; font-size:10px; font-weight:600; border:1.5px solid var(--mut); border-radius:0; padding:0 5px; color:var(--mut); }
.lp .cap { display:flex; gap:11px; align-items:flex-start; font-size:14px; margin-bottom:13px; line-height:1.4; color:var(--fg); } .lp .cap b { display:block; font-size:12px; color:var(--mut); font-weight:500; }
.lp .m2 .row { display:flex; align-items:center; gap:11px; font-size:14px; color:var(--fg); }
.lp .m2 .row .cb { color:var(--mut); } .lp .m2 .row .who { margin-left:auto; display:inline-flex; align-items:center; gap:7px; color:var(--mut); font-size:13px; }
.lp .cand { display:flex; align-items:center; gap:12px; padding:13px; border-radius:0; background:#fff; border:1px solid var(--line); margin-top:12px; }
.lp .cand.dim { opacity:.5; }
.lp .cand .nm { font-weight:500; font-size:15px; line-height:1.2; color:var(--fg); } .lp .cand .why { font-size:12.5px; color:var(--mut); }
.lp .assign { margin-left:auto; border:1px solid var(--fg); background:var(--fg); color:#fff; font-weight:500; font-size:13px; padding:7px 15px; border-radius:0; transition:background .2s,color .2s,border-color .2s; cursor:pointer; }
.lp .assign.done { background:var(--green); border-color:var(--green); }
.lp .pill { display:inline-block; font-size:11px; font-weight:500; padding:1px 9px; border-radius:0; background:rgba(22,163,74,.12); color:var(--green); margin-top:5px; }
@media (max-width:940px) { .lp .frow { grid-template-columns:1fr; gap:34px; margin-top:80px; } .lp .frow.flip .ftxt { order:0; } }

/* statement + sticky notes */
.lp .statement { text-align:center; }
.lp .statement h2 { max-width:900px; margin-inline:auto; }
.lp .board { position:relative; height:470px; max-width:860px; margin:70px auto 0; }
.lp .sticky { position:absolute; width:min(236px, 31%); padding:18px 16px 14px; background:#fef9c3; color:#422006; box-shadow:0 10px 30px -14px rgba(0,0,0,.18); font-weight:500; line-height:1.3; font-size:15px; text-align:left; border:1px solid rgba(0,0,0,.04); border-radius:0; }
.lp .sticky .q { display:block; margin-top:8px; font-weight:400; font-size:12px; color:#78350f; font-style:italic; }
.lp .sticky.no .q { color:#9b1c1c; }
.lp .sticky .tick { position:absolute; right:10px; top:8px; }
.lp .sticky .scrib { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.lp .stamp { position:absolute; right:-6px; bottom:-14px; font-size:11px; font-weight:600; letter-spacing:.08em; color:var(--red); border:2px solid var(--red); border-radius:0; padding:2px 9px; background:#fff; transform:rotate(-8deg); }
.lp .tally { display:flex; justify-content:center; gap:44px; margin-top:34px; }
.lp .tally div { font-size:13px; color:var(--mut); font-family:"DM Mono", ui-monospace, monospace; letter-spacing:.08em; text-transform:uppercase; } .lp .tally b { display:block; font-size:36px; line-height:1; letter-spacing:-.03em; color:var(--fg); font-family:"Hanken Grotesk", sans-serif; font-weight:500; text-transform:none; }
.lp .replay { margin-top:20px; background:none; border:0; color:var(--mut); font-weight:500; cursor:pointer; text-decoration:underline; text-underline-offset:4px; font-size:14px; }
.lp .replay:hover { color:var(--fg); }
@media (max-width:760px) { .lp .board { height:560px; } .lp .sticky { width:min(236px,46%); } }

/* bento */
.lp .bento { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; margin-top:54px; }
.lp .bc { background:#fff; border:1px solid var(--line); border-radius:0; padding:24px; overflow:hidden; display:flex; flex-direction:column; gap:18px; min-height:330px; }
.lp .bc .t b { display:block; font-size:18px; letter-spacing:-.02em; color:var(--fg); font-weight:500; } .lp .bc .t span { color:var(--mut); font-size:14px; }
.lp .bc .mock { background:var(--surface); border-color:var(--line); box-shadow:none; flex:1; min-height:0; padding:16px; }
.lp .c7 { grid-column:span 7; } .lp .c5 { grid-column:span 5; } .lp .c4 { grid-column:span 4; }
.lp .chat .msg { display:flex; gap:11px; align-items:flex-start; margin-bottom:14px; font-size:14px; color:var(--fg); } .lp .chat .msg .t b { display:block; font-size:12.5px; color:var(--mut); margin-bottom:1px; font-weight:500; }
.lp .bot { width:26px; height:26px; border-radius:0; background:var(--fg); display:grid; place-items:center; flex:none; }
.lp .src { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; } .lp .src span { font-size:11.5px; font-weight:500; padding:3px 10px; border-radius:0; background:#fff; border:1px solid var(--line); color:var(--mut); font-family:"DM Mono", ui-monospace, monospace; }
.lp .think { display:inline-flex; gap:5px; padding:6px 0; } .lp .think i { width:6px; height:6px; border-radius:50%; background:var(--mut-2); }
.lp .toasts { display:flex; flex-direction:column; gap:10px; flex:1; justify-content:center; }
.lp .toast { display:flex; gap:12px; align-items:flex-start; background:#fff; border:1px solid var(--line); border-radius:0; padding:12px 14px; font-size:13.5px; color:var(--fg); }
.lp .toast b { display:block; font-size:13.5px; color:var(--fg); font-weight:500; } .lp .toast span { color:var(--mut); font-size:12.5px; display:block; }
.lp .ti { width:26px; height:26px; border-radius:0; background:var(--fg); display:grid; place-items:center; flex:none; font-weight:600; color:#fff; } .lp .ti.g { background:var(--green); } .lp .ti.y { background:var(--amber); }
.lp .toast em { display:flex; gap:12px; margin-top:7px; font-style:normal; } .lp .toast u { text-decoration:none; font-size:12px; font-weight:500; padding:3px 11px; border-radius:0; border:1px solid var(--line); color:var(--fg); }
.lp .owners .orow { display:flex; align-items:center; gap:12px; padding:9px 8px; border-radius:0; position:relative; transition:background .3s; font-size:14px; color:var(--fg); }
.lp .owners .orow b { display:block; line-height:1.2; font-weight:500; } .lp .owners .orow span { font-size:12px; color:var(--mut); }
.lp .owners .orow.on { background:#fff; box-shadow:inset 0 0 0 1px var(--line); } .lp .pick { margin-left:auto; width:16px; height:16px; border-radius:50%; border:1.5px solid var(--line); } .lp .orow.on .pick { background:var(--green); border-color:var(--green); }
.lp .tools3 { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; place-items:center; flex:1; align-content:center; }
.lp .exp .erow { display:flex; justify-content:space-between; align-items:center; padding:10px 8px; border-radius:0; font-size:14px; font-weight:500; transition:background .3s; color:var(--fg); } .lp .exp .erow.on { background:#fff; box-shadow:inset 0 0 0 1px var(--line); color:var(--fg); }
@media (max-width:940px) { .lp .c7, .lp .c5, .lp .c4 { grid-column:span 12; } }
@media (min-width:941px) and (max-width:1100px) { .lp .c4 { grid-column:span 6; } }

/* security */
.lp .sec2 { display:grid; grid-template-columns:1fr 1fr; gap:60px; align-items:start; }
.lp .checks { list-style:none; padding:0; margin:30px 0 0; display:flex; flex-direction:column; gap:14px; }
.lp .checks li { display:flex; gap:12px; align-items:flex-start; font-size:15.5px; color:var(--fg); } .lp .checks svg { color:var(--fg); flex:none; margin-top:3px; }
.lp .prows { display:flex; flex-direction:column; gap:10px; margin-top:34px; }
.lp .prow { display:flex; gap:14px; align-items:center; padding:14px 16px; background:#fff; border:1px solid var(--line); border-radius:0; }
.lp .prow .pi { width:36px; height:36px; border-radius:0; display:grid; place-items:center; background:var(--surface); flex:none; color:var(--fg); border:1px solid var(--line); }
.lp .prow b { display:block; font-size:15px; letter-spacing:-.01em; color:var(--fg); font-weight:500; } .lp .prow span { font-size:13.5px; color:var(--mut); }
.lp .log { background:#fff; border:1px solid var(--line); border-radius:0; padding:6px 6px 10px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
.lp .lh { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; font-size:11.5px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); font-family:"DM Mono", ui-monospace, monospace; }
.lp .lrow { display:flex; align-items:center; gap:12px; padding:13px 16px; border-top:1px solid var(--line); font-size:14px; color:var(--fg); }
.lp .lic { width:22px; height:22px; border-radius:50%; display:grid; place-items:center; flex:none; font-weight:600; font-size:12.5px; }
.lp .lrow.ok .lic { background:rgba(22,163,74,.14); color:var(--green); } .lp .lrow.no .lic { background:rgba(220,38,38,.12); color:var(--red); } .lp .lrow.warn .lic { background:rgba(217,119,6,.14); color:var(--amber); }
.lp .lrow .ts { margin-left:auto; font-size:11.5px; color:var(--mut); white-space:nowrap; }
@media (max-width:940px) { .lp .sec2 { grid-template-columns:1fr; } }

/* faq */
.lp .faq { max-width:820px; margin:48px auto 0; border-top:1px solid var(--line); }
.lp .qa { border-bottom:1px solid var(--line); }
.lp .qa .q { width:100%; display:flex; justify-content:space-between; align-items:center; gap:20px; text-align:left; background:none; border:0; color:var(--fg); padding:26px 4px; font-size:clamp(18px,2vw,22px); font-weight:600; letter-spacing:-.02em; cursor:pointer; }
.lp .qa .pm { position:relative; width:18px; height:18px; flex:none; } .lp .qa .pm::before, .lp .qa .pm::after { content:""; position:absolute; left:0; top:8px; width:18px; height:1.5px; background:var(--fg); transition:transform .35s; } .lp .qa .pm::after { transform:rotate(90deg); }
.lp .qa.open .pm::after { transform:rotate(0); }
.lp .qa .a { height:0; overflow:hidden; } .lp .qa .a p { color:var(--mut); padding:0 4px 26px; max-width:700px; line-height:1.55; font-size:15px; }

/* closing */
.lp .cta { text-align:center; padding:120px 0 110px; position:relative; border-top:1px solid var(--line); overflow:hidden; background:var(--surface); }
.lp .cta::before { content:""; position:absolute; left:50%; top:30%; width:900px; height:560px; transform:translateX(-50%); background:radial-gradient(closest-side, rgba(40,109,248,.06), transparent); pointer-events:none; }
.lp .cta h2 { font-size:clamp(44px, 8.4vw, 120px); line-height:.97; letter-spacing:-.05em; font-weight:700; position:relative; color:var(--fg); }
.lp .cta p { color:var(--mut); margin:26px auto 0; max-width:520px; position:relative; font-size:16px; line-height:1.5; }
.lp .cta .ctas { position:relative; } .lp .cta .works { position:relative; }
.lp footer.foot { border-top:1px solid var(--line); padding:54px 0 40px; font-size:14px; color:var(--mut); background:#fff; }
.lp .fgrid { display:grid; grid-template-columns:1.4fr repeat(3,1fr); gap:30px; } .lp .fgrid b { display:block; color:var(--fg); margin-bottom:12px; font-size:13.5px; font-weight:500; } .lp .fgrid a { display:block; padding:3px 0; } .lp .fgrid a:hover { color:var(--fg); }
.lp .legal { margin-top:40px; padding-top:20px; border-top:1px solid var(--line); font-size:12.5px; color:var(--mut-2); line-height:1.5; }
@media (max-width:760px) { .lp .fgrid { grid-template-columns:1fr 1fr; } }

.lp .lm { display:block; overflow:hidden; padding-bottom:.12em; margin-bottom:-.08em; }
.lp .li { display:block; }
.lp .own { position:relative; display:inline-block; }
.lp .own .squig { position:absolute; left:0; right:0; bottom:-.1em; width:100%; height:.26em; transform:none; overflow:visible; }
.lp .ty, .lp .ct, .lp .q1, .lp .a1 { display:block; }
.lp .pl > div, .lp .ic > div { flex:1; min-width:0; } .lp .pl span:not(.av), .lp .ic span { display:block; }
.lp .hero .fine { margin-top:26px; }
.lp .cta .it { color:var(--hl); }
@media (prefers-reduced-motion:reduce) { .lp *, .lp *::before, .lp *::after { animation:none !important; transition:none !important; } }
`
