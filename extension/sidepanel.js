const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);

const state = { snap: null, cfg: { server: "https://slack.derpx06.live", token: "", autoSend: true }, store: { decisions: [], tasks: [] }, chat: [], connected: null };
const hue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
const ask = (msg) => chrome.runtime.sendMessage(msg);

// ---------- tabs ----------
function show(tab) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("on", s.id === tab));
  try { sessionStorage.setItem("tab", tab); } catch {}
}
$("tabs").onclick = (e) => { const t = e.target.closest("button")?.dataset.tab; if (t) show(t); };

// ---------- settings (autosaved) ----------
async function loadCfg() {
  const s = await chrome.storage.local.get(["server", "token", "autoSend"]);
  state.cfg = { server: s.server || state.cfg.server, token: s.token || "", autoSend: s.autoSend !== false };
  $("server").value = state.cfg.server; $("token").value = state.cfg.token; $("autoSend").checked = state.cfg.autoSend;
}
let saveTimer;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.cfg = { server: $("server").value.trim().replace(/\/+$/, ""), token: $("token").value.trim(), autoSend: $("autoSend").checked };
    await chrome.storage.local.set(state.cfg);
    testConn();
  }, 500);
}
["server", "token", "autoSend"].forEach((id) => $(id).addEventListener("input", saveCfg));
$("reveal").onclick = () => { const t = $("token"); t.type = t.type === "password" ? "text" : "password"; $("reveal").textContent = t.type === "password" ? "Show" : "Hide"; };

async function testConn() {
  if (!state.cfg.token) { state.connected = false; setConn("Paste your API token to connect.", ""); return; }
  setConn("Checking…", "");
  const r = await ask({ type: "test" });
  state.connected = !!r?.ok;
  setConn(r?.ok ? "Connected" : r?.status === 401 ? "Token rejected" : `Can't reach server${r?.error ? ": " + r.error : ""}`, r?.ok ? "ok" : "bad");
  render();
}
function setConn(text, cls) { $("conn").textContent = text; $("conn").className = "conn " + cls; }

// ---------- per-meeting store ----------
const storeKey = () => `meeting:${state.snap?.key ?? "none"}`;
async function loadStore() {
  const s = (await chrome.storage.local.get(storeKey()))[storeKey()];
  state.store = s ?? { decisions: [], tasks: [] };
}
const saveStore = () => chrome.storage.local.set({ [storeKey()]: state.store });

// ---------- live polling ----------
async function poll() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let snap = null;
  if (tab?.id != null) { try { snap = await chrome.tabs.sendMessage(tab.id, { type: "snapshot" }); } catch {} }
  const changed = (snap?.key ?? null) !== (state.snap?.key ?? null);
  state.snap = snap;
  if (changed) { state.chat = []; await loadStore(); renderTasks(); renderChat(); }
  renderLive();
}
setInterval(poll, 1500);

const speakers = () => [...new Set((state.snap?.lines ?? []).map((l) => l.speaker).filter(Boolean))];

function renderLive() {
  const s = state.snap;
  $("dot").classList.toggle("live", !!s?.lines.length);
  $("title").textContent = s ? s.title : "Brain";
  $("sub").textContent = s ? `${s.platform} · ${s.lines.length} lines · ${speakers().length} speaker${speakers().length === 1 ? "" : "s"}` : "Waiting for a call…";
  const box = $("transcript");
  const empty = !s ? "Open a Google Meet, Teams, Zoom (web) or Slack call in this window." : !s.lines.length ? "No captions yet. Turn captions on in the call (the CC button)." : "";
  $("liveEmpty").textContent = empty;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = (s?.lines ?? []).map((l) => `<div class="line"><div class="who" style="color:${hue(l.speaker || "?")}">${esc(l.speaker || "Unknown")}</div>${esc(l.text)}</div>`).join("");
  if (stick) box.scrollTop = box.scrollHeight;
  $("people").innerHTML = speakers().map((n) => `<option value="${esc(n)}">`).join("");
}

// ---------- ask ----------
const SUGGESTIONS = ["Summarize so far", "What have we decided?", "Who is doing what?", "What's still unresolved?"];
$("chips").innerHTML = SUGGESTIONS.map((q) => `<button type="button">${esc(q)}</button>`).join("");
$("chips").onclick = (e) => { const q = e.target.closest("button")?.textContent; if (q) sendQuestion(q); };
$("askForm").onsubmit = (e) => { e.preventDefault(); const q = $("q").value.trim(); if (q) { $("q").value = ""; sendQuestion(q); } };

function renderChat() {
  const c = $("chat");
  c.innerHTML = state.chat.length ? state.chat.map((m) => `<div class="msg ${m.role}${m.err ? " err" : ""}">${esc(m.text)}</div>`).join("") : `<div class="empty">Ask anything about the call so far.</div>`;
  c.scrollTop = c.scrollHeight;
}
function needReady() {
  if (!state.snap?.lines.length) return "There's no transcript yet. Turn captions on in the call first.";
  if (!state.connected) return "Connect to your Brain server in Settings first.";
  return null;
}
async function sendQuestion(q) {
  const block = needReady();
  state.chat.push({ role: "user", text: q });
  if (block) { state.chat.push({ role: "assistant", text: block, err: true }); return renderChat(); }
  state.chat.push({ role: "assistant", text: "Thinking…" }); renderChat();
  const history = state.chat.slice(0, -2).map((m) => ({ role: m.role, text: m.text }));
  const r = await ask({ type: "api", path: "/ext/ask", body: { lines: state.snap.lines, question: q, history } });
  state.chat.pop();
  state.chat.push(r?.ok ? { role: "assistant", text: r.data.answer } : { role: "assistant", text: failText(r), err: true });
  renderChat();
}
const failText = (r) => r?.status === 429 ? "Too many requests. Wait a moment." : r?.status === 401 ? "Token rejected. Check Settings." : "Something went wrong reaching the server. Try again.";

// ---------- tasks & decisions ----------
$("analyze").onclick = async () => {
  const block = needReady();
  if (block) { $("analyzeMsg").textContent = block; return; }
  $("analyze").disabled = true; $("analyzeMsg").textContent = "Reading the transcript…";
  const r = await ask({ type: "api", path: "/ext/analyze", body: { lines: state.snap.lines } });
  $("analyze").disabled = false;
  if (!r?.ok) { $("analyzeMsg").textContent = failText(r); return; }
  const known = new Set([...state.store.decisions.map((d) => d.text), ...state.store.tasks.map((t) => t.title)].map((t) => t.toLowerCase()));
  let added = 0;
  for (const text of r.data.decisions) if (!known.has(text.toLowerCase())) { state.store.decisions.push({ id: uid(), text }); added++; }
  for (const t of r.data.tasks) if (!known.has(t.title.toLowerCase())) { state.store.tasks.push({ id: uid(), title: t.title, assignee: t.assignee ?? "", due: t.due ?? "", done: false }); added++; }
  await saveStore(); renderTasks();
  $("analyzeMsg").textContent = added ? `Added ${added} new` : "Nothing new found";
};
$("decForm").onsubmit = async (e) => { e.preventDefault(); const t = $("decText").value.trim(); if (!t) return; state.store.decisions.push({ id: uid(), text: t }); $("decText").value = ""; await saveStore(); renderTasks(); };
$("taskForm").onsubmit = async (e) => { e.preventDefault(); const t = $("taskText").value.trim(); if (!t) return; state.store.tasks.push({ id: uid(), title: t, assignee: "", due: "", done: false }); $("taskText").value = ""; await saveStore(); renderTasks(); };

function renderTasks() {
  const { decisions, tasks } = state.store;
  $("decisions").innerHTML = decisions.length ? decisions.map((d) => `<li data-id="${d.id}"><div class="body">${esc(d.text)}</div><button class="x" data-del="dec" title="Remove">×</button></li>`).join("") : `<li class="muted">None yet.</li>`;
  $("taskList").innerHTML = tasks.length ? tasks.map((t) => `<li data-id="${t.id}" class="${t.done ? "done" : ""}">
    <input type="checkbox" data-done ${t.done ? "checked" : ""}>
    <div class="body"><div class="t">${esc(t.title)}</div>
      <div class="meta"><input data-assignee list="people" placeholder="Assign to…" value="${esc(t.assignee)}"><input data-due placeholder="Due" value="${esc(t.due)}"></div></div>
    <button class="x" data-del="task" title="Remove">×</button></li>`).join("") : `<li class="muted">None yet.</li>`;
}
$("decisions").onclick = async (e) => { if (e.target.dataset.del) { const id = e.target.closest("li").dataset.id; state.store.decisions = state.store.decisions.filter((d) => d.id !== id); await saveStore(); renderTasks(); } };
$("taskList").onclick = async (e) => {
  const li = e.target.closest("li"); if (!li?.dataset.id) return;
  if (e.target.dataset.del) { state.store.tasks = state.store.tasks.filter((t) => t.id !== li.dataset.id); await saveStore(); renderTasks(); }
  else if ("done" in e.target.dataset) { const t = state.store.tasks.find((x) => x.id === li.dataset.id); t.done = e.target.checked; await saveStore(); renderTasks(); }
};
$("taskList").addEventListener("change", async (e) => {
  const li = e.target.closest("li"); const t = state.store.tasks.find((x) => x.id === li?.dataset.id); if (!t) return;
  if ("assignee" in e.target.dataset) t.assignee = e.target.value.trim();
  if ("due" in e.target.dataset) t.due = e.target.value.trim();
  await saveStore();
});

// ---------- onboarding ----------
function render() {
  if (!state.cfg.token && !sessionStorage.getItem("skipSetup")) show("settings");
}
(async () => {
  await loadCfg();
  renderChat(); renderTasks();
  let tab = "live"; try { tab = sessionStorage.getItem("tab") || "live"; } catch {}
  show(state.cfg.token ? tab : "settings");
  await testConn();
  poll();
})();
