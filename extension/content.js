(() => {
  const adapter = globalThis.__brainAdapter;
  if (!adapter) return;

  const startedAt = new Date();
  const externalId = `${adapter.meetingId()}:${startedAt.toISOString().slice(0, 10)}`;
  /** @type {{ speaker: string, text: string }[]} */
  const lines = [];
  let timer = null;
  let sent = 0; // lines.length at last successful hand-off

  const merge = (snapshot) => BrainLib.mergeCaptions(lines, snapshot);

  const tick = () => { timer = null; try { merge(adapter.read()); } catch { /* DOM shape changed; keep what we have */ } };
  new MutationObserver(() => { if (!timer) timer = setTimeout(tick, 400); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  function payload() {
    tick();
    const me = adapter.selfName?.() ?? null;
    const named = lines.map((l) => ({ ...l, speaker: me && /^you$/i.test(l.speaker) ? me : l.speaker }));
    const participants = [...new Set([...(adapter.roster?.() ?? []), ...named.map((l) => l.speaker)].filter((n) => n && !/^you$/i.test(n)))];
    return { externalId, platform: adapter.platform, title: adapter.title(), participants, lines: named, startedAt: startedAt.toISOString(), endedAt: new Date().toISOString() };
  }

  function upload(manual = false) {
    const p = payload();
    if (!p.lines.length || p.lines.length === sent) return;
    sent = p.lines.length;
    chrome.runtime.sendMessage({ type: "upload", payload: p, manual }).catch(() => { sent = 0; });
  }

  // Summarizing costs a model call, so upload once when the call ends, not continuously.
  addEventListener("pagehide", () => upload());
  // A local backup so a crash or closed laptop doesn't lose the transcript; flushed by the worker later.
  setInterval(() => { const p = payload(); if (p.lines.length) chrome.runtime.sendMessage({ type: "backup", payload: p }).catch(() => {}); }, 30_000);

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === "status") reply({ platform: adapter.platform, lines: payload().lines.length, title: adapter.title() });
    if (msg?.type === "snapshot") {
      const p = payload();
      reply({
        key: `${p.platform}:${p.externalId}`, externalId: p.externalId, participants: p.participants, platform: p.platform, title: p.title, code: adapter.meetingId(), startedAt: p.startedAt, lines: p.lines,
        roster: [...new Set(adapter.roster?.() ?? [])], self: adapter.selfName?.() ?? null, captionsOn: adapter.captionsOn ? adapter.captionsOn() : p.lines.length > 0, canEnableCaptions: !!adapter.enableCaptions,
      });
    }
    if (msg?.type === "enableCaptions") reply({ ok: !!adapter.enableCaptions?.() });
    if (msg?.type === "send") { sent = 0; upload(true); reply({ ok: true }); }
  });
})();
