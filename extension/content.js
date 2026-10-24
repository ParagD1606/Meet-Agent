(() => {
  const adapter = globalThis.__brainAdapter;
  if (!adapter) return;

  const startedAt = new Date();
  const externalId = `${adapter.meetingId()}:${startedAt.toISOString().slice(0, 10)}`;
  /** @type {{ speaker: string, text: string }[]} */
  const lines = [];
  const last = new Map(); // speaker -> index in `lines` of that speaker's most recent line
  let timer = null;
  let sent = 0; // lines.length at last successful hand-off

  // Captions are rewritten in place as the speaker talks, so a snapshot line that extends
  // (or is a revision of) the speaker's previous line replaces it instead of adding a new one.
  function merge(snapshot) {
    for (const { speaker, text } of snapshot) {
      const i = last.get(speaker);
      const prev = i === undefined ? undefined : lines[i];
      if (prev && (text.startsWith(prev.text) || prev.text.startsWith(text) || sharedPrefix(prev.text, text) > 0.6)) {
        if (text.length >= prev.text.length) prev.text = text;
      } else {
        lines.push({ speaker, text });
        last.set(speaker, lines.length - 1);
      }
    }
  }
  function sharedPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    return n ? k / Math.max(a.length, b.length) : 0;
  }

  const tick = () => { timer = null; try { merge(adapter.read()); } catch { /* DOM shape changed; keep what we have */ } };
  new MutationObserver(() => { if (!timer) timer = setTimeout(tick, 400); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  function payload() {
    tick();
    return { externalId, platform: adapter.platform, title: adapter.title(), lines: lines.map((l) => ({ ...l })), startedAt: startedAt.toISOString(), endedAt: new Date().toISOString() };
  }

  function upload() {
    const p = payload();
    if (!p.lines.length || p.lines.length === sent) return;
    sent = p.lines.length;
    chrome.runtime.sendMessage({ type: "upload", payload: p }).catch(() => { sent = 0; });
  }

  // Summarizing costs a model call, so upload once when the call ends, not continuously.
  addEventListener("pagehide", upload);
  // A local backup so a crash or closed laptop doesn't lose the transcript; flushed by the worker later.
  setInterval(() => { const p = payload(); if (p.lines.length) chrome.runtime.sendMessage({ type: "backup", payload: p }).catch(() => {}); }, 30_000);

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === "status") reply({ platform: adapter.platform, lines: payload().lines.length, title: adapter.title() });
    if (msg?.type === "snapshot") {
      const p = payload();
      reply({ key: `${p.platform}:${p.externalId}`, platform: p.platform, title: p.title, startedAt: p.startedAt, lines: p.lines });
    }
    if (msg?.type === "send") { sent = 0; upload(); reply({ ok: true }); }
  });
})();
