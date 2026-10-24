// Service worker: owns the server connection so content scripts never see the token.
const BACKUP = "pending"; // externalId -> payload that has not reached the server yet

async function settings() {
  const { server = "", token = "" } = await chrome.storage.local.get(["server", "token"]);
  return { server: server.replace(/\/+$/, ""), token };
}

async function post(payload) {
  const { server, token } = await settings();
  if (!server || !token) throw new Error("Set the server URL and API token in the extension popup.");
  const res = await fetch(`${server}/ext/meetings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  return res.json();
}

async function pending() { return (await chrome.storage.local.get(BACKUP))[BACKUP] ?? {}; }
async function setPending(p) { await chrome.storage.local.set({ [BACKUP]: p }); }

async function upload(payload) {
  const key = `${payload.platform}:${payload.externalId}`;
  try {
    // Decisions and tasks the user recorded in the side panel travel with the transcript.
    const notes = (await chrome.storage.local.get(`meeting:${key}`))[`meeting:${key}`];
    const body = { ...payload };
    if (notes?.decisions?.length) body.decisions = notes.decisions.map((d) => d.text);
    if (notes?.tasks?.length) body.tasks = notes.tasks.map((t) => ({ title: t.title, assignee: t.assignee || undefined, due: t.due || undefined, done: !!t.done }));
    await post(body);
    const p = await pending(); delete p[key]; await setPending(p);
    await chrome.storage.local.set({ lastUpload: { at: Date.now(), title: payload.title, ok: true } });
  } catch (err) {
    const p = await pending(); p[key] = payload; await setPending(p);
    await chrome.storage.local.set({ lastUpload: { at: Date.now(), title: payload.title, ok: false, error: String(err.message ?? err) } });
  }
}

async function flushOld() {
  // Backups older than 10 minutes belong to calls that have ended (or crashed); send them.
  const p = await pending();
  for (const [key, payload] of Object.entries(p)) {
    if (Date.now() - Date.parse(payload.endedAt) > 10 * 60_000) await upload(payload);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "backup") {
    pending().then((p) => { p[`${msg.payload.platform}:${msg.payload.externalId}`] = msg.payload; return setPending(p); }).then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === "upload") {
    chrome.storage.local.get("autoSend").then(({ autoSend }) => (autoSend === false && !msg.manual ? null : upload(msg.payload))).then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === "test") {
    settings().then(async ({ server, token }) => {
      try {
        const r = await fetch(`${server}/ext/ping`, { headers: { authorization: `Bearer ${token}` } });
        reply({ ok: r.ok, status: r.status });
      } catch (e) { reply({ ok: false, error: String(e.message ?? e) }); }
    });
    return true;
  }
});

// The side panel never holds the token: it asks the worker to call the server.
async function api(path, body) {
  const { server, token } = await settings();
  if (!server || !token) return { ok: false, status: 0, error: "not_configured" };
  try {
    const res = await fetch(`${server}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) { return { ok: false, status: 0, error: String(e.message ?? e) }; }
}
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === "api") { api(msg.path, msg.body).then(reply); return true; }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("flush", { periodInMinutes: 5 }));
chrome.runtime.onStartup.addListener(flushOld);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "flush") flushOld(); });
