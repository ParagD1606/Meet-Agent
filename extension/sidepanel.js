const $ = (id) => document.getElementById(id);
const { renderNotes, uid, parseTranscript, findDuplicates, workload, workloadHint, migrate, dueChips, badge } = BrainLib;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 50% 42%)`; };
const ask = (msg) => chrome.runtime.sendMessage(msg);
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const initials = (n) => (String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

const state = {
  cfg: { server: "https://slack.derpx06.live", token: "", autoSend: true, autoDetect: true },
  snap: null,       // live capture from the call tab
  manual: null,     // imported transcript { key, externalId, title, lines, startedAt } while set, it replaces the live one
  store: { items: [] },
  load: {},         // open approved tasks per person, across meetings
  chat: [], connected: null, editing: new Set(),
  analyzing: false, lastRun: 0, lastCount: {},
};
const src = () => state.manual ?? state.snap;
const lines = () => src()?.lines ?? [];
const speakers = () => [...new Set(lines().map((l) => l.speaker).filter(Boolean))];
const roster = () => [...new Set([...(state.manual ? [] : state.snap?.roster ?? []), ...speakers()])];
const storeKey = () => `meeting:${src()?.key ?? "none"}`;

// ---------- tabs ----------
function show(tab) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("on", s.id === tab));
  try { sessionStorage.setItem("tab", tab); } catch {}
}
$("tabs").onclick = (e) => { const t = e.target.closest("button")?.dataset.tab; if (t) show(t); };

// ---------- settings (autosaved) ----------
async function loadCfg() {
  const s = await chrome.storage.local.get(["server", "token", "autoSend", "autoDetect"]);
  state.cfg = { server: s.server || state.cfg.server, token: s.token || "", autoSend: s.autoSend !== false, autoDetect: s.autoDetect !== false };
  $("server").value = state.cfg.server; $("token").value = state.cfg.token;
  $("autoSend").checked = state.cfg.autoSend; $("autoDetect").checked = state.cfg.autoDetect;
}
let saveTimer;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.cfg = { server: $("server").value.trim().replace(/\/+$/, ""), token: $("token").value.trim(), autoSend: $("autoSend").checked, autoDetect: $("autoDetect").checked };
    await chrome.storage.local.set(state.cfg);
    testConn();
  }, 500);
}
["server", "token", "autoSend", "autoDetect"].forEach((id) => $(id).addEventListener("input", saveCfg));
$("reveal").onclick = () => { const t = $("token"); t.type = t.type === "password" ? "text" : "password"; $("reveal").textContent = t.type === "password" ? "Show" : "Hide"; };

async function testConn() {
  if (!state.cfg.token) { state.connected = false; return setConn("Paste your API token to connect.", ""); }
  setConn("Checking…", "");
  const r = await ask({ type: "test" });
  state.connected = !!r?.ok;
  setConn(r?.ok ? "Connected" : r?.status === 401 ? "Token rejected" : `Can't reach server${r?.error ? ": " + r.error : ""}`, r?.ok ? "ok" : "bad");
}
function setConn(text, cls) { $("conn").textContent = text; $("conn").className = "conn " + cls; }

// ---------- per-meeting store ----------
async function loadStore() {
  const s = (await chrome.storage.local.get(storeKey()))[storeKey()];
  state.store = migrate(s ?? { items: [] });
  renderNotesTab();
  state.editing.clear();
  await refreshLoad();
}
async function refreshLoad() {
  const all = await chrome.storage.local.get(null);
  state.load = workload(Object.entries(all).filter(([k]) => k.startsWith("meeting:") && k !== storeKey()).map(([, v]) => migrate(v)).concat([state.store]));
}
async function persist() { await chrome.storage.local.set({ [storeKey()]: state.store }); await refreshLoad(); renderItems(); }

// ---------- live capture ----------
async function poll() {
  const tab = await activeTab();
  let snap = null;
  if (tab?.id != null) { try { snap = await chrome.tabs.sendMessage(tab.id, { type: "snapshot" }); } catch {} }
  const before = src()?.key;
  state.snap = snap;
  if (src()?.key !== before) { state.chat = []; state.lastRun = 0; await loadStore(); renderChat(); renderItems(); }
  renderLive();
  maybeAutoDetect();
}
setInterval(poll, 1500);

function renderLive() {
  const s = src();
  $("dot").classList.toggle("live", !!s?.lines.length && !state.manual);
  $("title").textContent = s ? s.title : "Brain";
  $("subText").textContent = s ? `${state.manual ? "imported" : s.platform} · ${s.lines.length} lines · ${speakers().length} speaker${speakers().length === 1 ? "" : "s"}` : "Waiting for a call…";
  $("backLive").hidden = !state.manual;
  $("capBanner").hidden = !(state.snap && !state.snap.captionsOn && !state.manual);
  $("capOn").hidden = !state.snap?.canEnableCaptions;
  const box = $("transcript");
  $("liveEmpty").innerHTML = !s ? "<b>No call detected</b>Open a Google Meet, Teams, Zoom (web) or Slack call in this window, or import a transcript." : !s.lines.length ? "<b>Waiting for captions</b>Turn captions on in the call (the CC button) and they will appear here." : "";
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const hl = box.querySelector(".hl")?.dataset.i;
  box.innerHTML = lines().map((l, i) => `<div class="line${String(i + 1) === hl ? " hl" : ""}" data-i="${i + 1}"><div class="av" style="background:${hue(l.speaker || "?")}">${esc(initials(l.speaker))}</div><div><div class="who">${esc(l.speaker || "Unknown")}<span class="ts">${hhmm(l.t)}</span></div><div class="say">${esc(l.text)}</div></div></div>`).join("");
  if (stick && !hl) box.scrollTop = box.scrollHeight;
  $("people").innerHTML = roster().map((n) => `<option value="${esc(n)}">`).join("");
}
$("capOn").onclick = async () => { const tab = await activeTab(); try { await chrome.tabs.sendMessage(tab.id, { type: "enableCaptions" }); } catch {} };

function jumpTo(n) {
  show("live");
  const el = $("transcript").querySelector(`.line[data-i="${n}"]`);
  if (!el) return;
  el.classList.add("hl"); el.scrollIntoView({ block: "center" });
  setTimeout(() => el.classList.remove("hl"), 3500);
}

// ---------- import / recap ----------
$("importBtn").onclick = () => modal(`<h4>Import a transcript</h4><p class="muted">Paste text, or choose a .txt / .vtt / .srt file. Lines like “Name: what they said” work best.</p><input type="file" id="impFile" accept=".txt,.vtt,.srt,text/plain"><textarea id="impText" placeholder="Paste transcript or notes…"></textarea>`, async () => {
  const parsed = parseTranscript($("impText").value);
  if (!parsed.length) return false;
  const id = uid();
  state.manual = { key: `import:${id}`, externalId: id, platform: "import", title: "Imported transcript", lines: parsed, startedAt: new Date().toISOString(), roster: [] };
  await loadStore(); renderLive(); renderItems(); renderChat(); show("live");
}, "Import");
document.addEventListener("change", async (e) => { if (e.target.id === "impFile" && e.target.files[0]) $("impText").value = await e.target.files[0].text(); });
$("backLive").onclick = async () => { state.manual = null; await loadStore(); renderLive(); renderItems(); renderChat(); };

$("recap").onclick = async () => {
  const box = $("recapBox"); box.hidden = false;
  const block = needReady(); if (block) { box.textContent = block; return; }
  box.textContent = "Catching you up…";
  const r = await callAsk("I just joined. Give me a short recap: what is being discussed now, decisions made, tasks assigned and to whom, and open questions.");
  box.textContent = r.ok ? r.text : r.text;
};

// ---------- ask ----------
const SUGGESTIONS = ["Summarize so far", "What did we decide?", "Who is free to take this?", "What's still unresolved?"];
$("chips").innerHTML = SUGGESTIONS.map((q) => `<button type="button" class="sm">${esc(q)}</button>`).join("");
$("chips").onclick = (e) => { const q = e.target.closest("button")?.textContent; if (q) sendQuestion(q); };
$("askForm").onsubmit = (e) => { e.preventDefault(); const q = $("q").value.trim(); if (q) { $("q").value = ""; sendQuestion(q); } };

function renderChat() {
  const c = $("chat");
  c.innerHTML = state.chat.length ? state.chat.map((m) => `<div class="msg ${m.role}${m.err ? " err" : ""}">${esc(m.text)}</div>`).join("") : `<div class="empty"><b>Ask about the call</b>Try “What did we decide?” or “Who is free to take this?”</div>`;
  c.scrollTop = c.scrollHeight;
}
function needReady() {
  if (!lines().length) return "There's no transcript yet. Turn captions on in the call first.";
  if (!state.connected) return "Connect to your Brain server in Settings first.";
  return null;
}
const failText = (r) => r?.status === 429 ? "Too many requests. Wait a moment." : r?.status === 401 ? "Token rejected. Check Settings." : "Something went wrong reaching the server. Try again.";
const context = () => ({ title: src()?.title, startedAt: src()?.startedAt, roster: roster() });
const notes = () => state.store.items.filter((i) => i.status !== "rejected").map((i) => `- [${i.kind}${i.status === "approved" ? ", approved" : ""}] ${i.title}${i.assignee ? ` (${i.assignee}${i.due ? ", " + i.due : ""})` : ""}`).join("\n");
const workloadNote = () => Object.entries(state.load).map(([n, c]) => `${n}: ${c} open task${c === 1 ? "" : "s"}`).join("; ");

async function callAsk(question, history = []) {
  const r = await ask({ type: "api", path: "/ext/ask", body: { lines: lines(), question, history, context: { ...context(), notes: [notes(), workloadNote() && `Workload: ${workloadNote()}`].filter(Boolean).join("\n") } } });
  return r?.ok ? { ok: true, text: r.data.answer } : { ok: false, text: failText(r) };
}
async function sendQuestion(q) {
  const block = needReady();
  state.chat.push({ role: "user", text: q });
  if (block) { state.chat.push({ role: "assistant", text: block, err: true }); return renderChat(); }
  state.chat.push({ role: "assistant", text: "Thinking…" }); renderChat();
  const history = state.chat.slice(0, -2).map((m) => ({ role: m.role, text: m.text }));
  const r = await callAsk(q, history);
  state.chat.pop(); state.chat.push({ role: "assistant", text: r.text, err: !r.ok }); renderChat();
}

// ---------- detected items ----------
async function detect(auto = false) {
  if (state.analyzing) return;
  const block = needReady();
  if (block) { if (!auto) $("detectMsg").textContent = block; return; }
  state.analyzing = true; if (!auto) { state.lastRun = Date.now(); state.lastCount[src().key] = lines().length; }
  $("detect").disabled = true; if (!auto) $("detectMsg").textContent = "Reading the whole transcript…";
  const r = await ask({ type: "api", path: "/ext/analyze", body: { lines: lines(), context: context(), known: state.store.items.map((i) => i.title) } });
  state.analyzing = false; $("detect").disabled = false;
  if (!r?.ok) { if (!auto) $("detectMsg").textContent = failText(r); return; }
  const known = new Set(state.store.items.map((i) => i.title.toLowerCase()));
  const fresh = r.data.items.filter((i) => !known.has(i.title.toLowerCase()));
  for (const i of fresh) state.store.items.push({ id: uid(), status: "pending", done: false, ...i, assignee: i.assignee ?? "", due: i.due ?? "" });
  $("detectMsg").textContent = fresh.length ? `${fresh.length} new to review` : auto ? "" : "Nothing new found";
  await persist();
}
$("detect").onclick = () => detect(false);
const AUTO_MS = 120_000; // live notes refresh on this cycle; decisions and tasks are only made at the end
function maybeAutoDetect() {
  if (!state.cfg.autoDetect || !state.connected || state.updatingNotes || state.manual || !src()) return;
  if (lines().length - (state.lastCount[src().key] ?? 0) < 3 || Date.now() - state.lastRun < AUTO_MS) return;
  updateNotes(true);
}

// ---------- live notes ----------
function renderNotesTab() {
  const n = state.store.notes;
  $("notesBody").innerHTML = n?.text ? renderNotes(n.text) : `<div class="empty"><b>No notes yet</b>Live notes appear here and refresh every 2 minutes while the call runs. Press “Update now” to write the first ones.</div>`;
  $("notesMsg").textContent = n?.at ? `Updated ${hhmm(n.at)} · ${n.upTo} lines covered` : "";
}
async function updateNotes(auto = false) {
  if (state.updatingNotes) return;
  const block = needReady();
  if (block) { if (!auto) $("notesMsg").textContent = block; return; }
  const prev = state.store.notes, all = lines(), upTo = Math.min(prev?.upTo ?? 0, all.length);
  if (prev && upTo === all.length) { if (!auto) $("notesMsg").textContent = "Already up to date"; return; }
  state.updatingNotes = true; state.lastRun = Date.now(); state.lastCount[src().key] = all.length;
  $("notesNow").disabled = true; if (!auto) $("notesMsg").textContent = "Writing notes…";
  const r = await ask({ type: "api", path: "/ext/notes", body: { lines: all.slice(upTo), offset: upTo, previous: prev?.text ?? "", context: context() } });
  state.updatingNotes = false; $("notesNow").disabled = false;
  if (!r?.ok) { if (!auto) $("notesMsg").textContent = failText(r); return; }
  state.store.notes = { text: r.data.notes, at: Date.now(), upTo: all.length };
  await chrome.storage.local.set({ [storeKey()]: state.store });
  renderNotesTab();
}
$("notesNow").onclick = () => updateNotes(false);

$("addForm").onsubmit = async (e) => {
  e.preventDefault(); const t = $("addText").value.trim(); if (!t) return;
  state.store.items.push({ id: uid(), kind: $("addKind").value, label: "confirmed", title: t, reason: "Added by you", evidence: [], assignee: "", due: "", status: "approved", done: false });
  $("addText").value = ""; await persist();
};
$("approveAll").onclick = async () => {
  for (const i of state.store.items) if (i.status === "pending" && i.label === "confirmed" && i.kind !== "question") i.status = "approved";
  await persist();
};

function renderItems() {
  const items = state.store.items;
  const pending = items.filter((i) => i.status === "pending").length;
  $("pendingCount").hidden = !pending; $("pendingCount").textContent = pending;
  const dups = findDuplicates(items), byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const rank = { pending: 0, approved: 1, rejected: 2 };
  const sorted = [...items].sort((a, b) => rank[a.status] - rank[b.status]);
  if (!sorted.length) { $("itemList").innerHTML = `<div class="empty"><b>Nothing detected yet</b>Decisions, tasks and open questions show up here for you to approve, edit or reject. Nothing is saved until you approve it and send.</div>`; return; }
  $("itemList").innerHTML = sorted.map((i) => {
    const edit = state.editing.has(i.id), isTask = i.kind === "task";
    const dup = dups[i.id] && byId[dups[i.id].otherId];
    const hint = isTask && i.status !== "rejected" ? workloadHint(i.assignee, state.load, roster()) : null;
    return `<div class="item ${i.status} k-${i.kind === "question" || i.kind === "decision" ? i.kind : i.label}" data-id="${i.id}">
      <div class="top"><span class="badge ${i.kind === "question" ? "question" : i.kind === "decision" && i.label === "confirmed" ? "decision" : i.label}">${esc(badge(i))}</span><span class="muted">${esc(i.kind)}</span></div>
      ${edit ? `<div class="fields"><input class="wide" data-f="title" value="${esc(i.title)}"><select data-f="kind"><option ${isTask ? "selected" : ""} value="task">Task</option><option ${i.kind === "decision" ? "selected" : ""} value="decision">Decision</option><option ${i.kind === "question" ? "selected" : ""} value="question">Question</option></select></div>`
        : `<div class="title ${i.done ? "done-t" : ""}">${esc(i.title)}</div>`}
      ${i.reason ? `<div class="why">${esc(i.reason)}</div>` : ""}
      ${(i.evidence ?? []).map((n) => `<button class="ev" data-act="jump" data-n="${n}">line ${n}</button>`).join("")}
      ${isTask ? `<div class="fields"><input data-f="assignee" list="people" placeholder="Assign to…" value="${esc(i.assignee)}"><input data-f="due" placeholder="Due" value="${esc(i.due)}"></div>
        ${!i.assignee && roster().length ? `<div class="chipsrow"><span class="q">Who owns this?</span>${roster().slice(0, 6).map((n) => `<button class="sm" data-act="owner" data-v="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}
        ${!i.due ? `<div class="chipsrow"><span class="q">When?</span>${dueChips(src()?.startedAt ? new Date(src().startedAt) : new Date()).map(([l, v]) => `<button class="sm" data-act="due" data-v="${v}">${l}</button>`).join("")}</div>` : ""}` : ""}
      ${hint ? `<div class="warn">${esc(i.assignee)} already has ${hint.count} open tasks; ${esc(hint.alt)} has ${hint.altCount}. <button class="sm" data-act="owner" data-v="${esc(hint.alt)}">Reassign to ${esc(hint.alt)}</button></div>` : ""}
      ${dup ? `<div class="warn ${dups[i.id].conflict ? "conflict" : ""}">${dups[i.id].conflict ? `Deadline conflict with “${esc(dup.title)}” (${esc(dup.due)} vs ${esc(i.due)}).` : `Similar to “${esc(dup.title)}”.`} <button class="sm" data-act="merge">Merge</button><button class="sm" data-act="keep">Keep both</button><button class="sm" data-act="reject">Dismiss</button></div>` : ""}
      <div class="acts">${i.status === "pending" ? `<button class="sm ok" data-act="approve">${i.kind === "question" ? "Keep" : "Approve"}</button><button class="sm" data-act="edit">${edit ? "Done" : "Edit"}</button><button class="sm no" data-act="reject">Reject</button>`
        : i.status === "approved" ? `${isTask ? `<label class="muted"><input type="checkbox" data-act="done" ${i.done ? "checked" : ""}> done</label>` : ""}<button class="sm" data-act="edit">${edit ? "Done" : "Edit"}</button><button class="sm" data-act="undo">Undo</button>`
        : `<button class="sm" data-act="undo">Restore</button>`}</div></div>`;
  }).join("");
}

$("itemList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const card = btn.closest(".item"); const item = state.store.items.find((i) => i.id === card?.dataset.id);
  const act = btn.dataset.act;
  if (act === "jump") return jumpTo(Number(btn.dataset.n));
  if (!item) return;
  if (act === "approve") item.status = "approved";
  else if (act === "reject") item.status = "rejected";
  else if (act === "undo") item.status = "pending";
  else if (act === "done") item.done = btn.checked;
  else if (act === "edit") { state.editing.has(item.id) ? state.editing.delete(item.id) : state.editing.add(item.id); return renderItems(); }
  else if (act === "owner") item.assignee = btn.dataset.v;
  else if (act === "due") item.due = btn.dataset.v;
  else if (act === "keep") item.dismissed = true;
  else if (act === "merge") {
    const other = state.store.items.find((i) => i.id === findDuplicates(state.store.items)[item.id]?.otherId);
    if (other) { other.assignee ||= item.assignee; other.due ||= item.due; state.store.items = state.store.items.filter((i) => i !== item); }
  }
  await persist();
});
$("itemList").addEventListener("change", async (e) => {
  const f = e.target.dataset.f; const item = state.store.items.find((i) => i.id === e.target.closest(".item")?.dataset.id);
  if (!f || !item) return;
  item[f] = e.target.value.trim();
  if (f === "kind") state.editing.delete(item.id);
  await persist();
});

// ---------- finish & send ----------
const meetingsUrl = () => `${state.cfg.server}/meetings`;
function renderFinal(m) {
  const box = $("finalBox"); box.hidden = false;
  const link = `<a href="${esc(meetingsUrl())}" target="_blank" rel="noreferrer">Open in Meeting notes ↗</a>`;
  if (m.error) { box.innerHTML = `<h3>Not saved</h3><p>${esc(m.error)}</p><p class="muted">The transcript is kept on this device and will be retried.</p>`; return; }
  if (m.status === "processing") { box.innerHTML = `<h3>Saved. Writing the final notes…</h3><p class="muted">Reading the whole transcript for decisions and tasks. This takes a moment.</p>${link}`; return; }
  if (m.status === "failed") { box.innerHTML = `<h3>Saved, but the final notes failed</h3><p class="muted">The transcript is in Meeting notes. The model could not write the summary.</p>${link}`; return; }
  const d = (m.decisions ?? []).map((x) => `<li>${esc(x)}</li>`).join(""), t = (m.tasks ?? []).map((k) => `<li><span class="who">${esc(k.assigneeName || "Unassigned")}</span>: ${esc(k.title)}${k.dueDate ? ` <span class="muted">(due ${esc(k.dueDate)})</span>` : ""}</li>`).join("");
  box.innerHTML = `<h3>Final notes</h3><h5>Decisions</h5>${d ? `<ul>${d}</ul>` : `<p class="muted">No decisions were found in the transcript.</p>`}<h5>Tasks</h5>${t ? `<ul>${t}</ul>` : `<p class="muted">No tasks were found in the transcript.</p>`}<p>${link}</p>`;
}
async function followFinal(id) {
  for (let i = 0; i < 40; i++) {
    const r = await ask({ type: "api", path: `/ext/meetings/${id}` });
    if (r?.ok && r.data.status !== "processing") return renderFinal(r.data);
    renderFinal({ status: "processing" });
    await new Promise((res) => setTimeout(res, 3000));
  }
  renderFinal({ status: "processing" });
}
function payloadNow() {
  const s = src();
  return { externalId: s.externalId, platform: s.platform, title: s.title, participants: state.manual ? speakers() : (s.participants ?? roster()),
    lines: s.lines.map(({ speaker, text }) => ({ speaker, text })), startedAt: s.startedAt, endedAt: new Date().toISOString() };
}
$("sendNotes").onclick = () => {
  const block = needReady(); if (block) { $("sendMsg").textContent = block; return; }
  const ok = state.store.items.filter((i) => i.status === "approved");
  const tasks = ok.filter((i) => i.kind === "task").length, decisions = ok.filter((i) => i.kind === "decision").length;
  modal(`<h4>Finish and send to Meeting notes?</h4><p>This saves the transcript, then Brain reads the <b>whole</b> of it to write the final decisions and tasks, with owner names.</p>
    ${tasks || decisions ? `<p>Also included: the <b>${tasks}</b> task${tasks === 1 ? "" : "s"} and <b>${decisions}</b> decision${decisions === 1 ? "" : "s"} you approved.</p>` : ""}
    <p class="muted">Nobody is notified. You can follow the result here and in the Brain web app.</p>`, async () => {
    $("sendNotes").disabled = true; $("sendMsg").textContent = "Sending…"; show("items");
    const r = await ask({ type: "upload", manual: true, payload: payloadNow() });
    $("sendNotes").disabled = false;
    if (!r?.ok) { $("sendMsg").textContent = "Failed"; return renderFinal({ error: r?.error ?? "unknown error" }); }
    $("sendMsg").textContent = "Saved";
    renderFinal({ status: "processing" }); followFinal(r.id);
  }, "Finish & send");
};

// ---------- modal ----------
let modalYes = null;
function modal(html, onYes, yesLabel = "Confirm") {
  $("modalBody").innerHTML = html; $("modalYes").textContent = yesLabel; modalYes = onYes; $("modal").hidden = false;
}
$("modalNo").onclick = () => { $("modal").hidden = true; };
$("modalYes").onclick = async () => { const keepOpen = (await modalYes?.()) === false; if (!keepOpen) $("modal").hidden = true; };

// ---------- boot ----------
(async () => {
  await loadCfg();
  renderChat();
  let tab = "live"; try { tab = sessionStorage.getItem("tab") || "live"; } catch {}
  show(state.cfg.token ? tab : "settings");
  await testConn();
  await poll();
  renderItems();
})();
