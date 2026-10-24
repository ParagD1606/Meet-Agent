// Pure helpers shared by the side panel (and unit-tested under bun). No DOM or chrome.* access here.
(() => {
  const uid = () => Math.random().toString(36).slice(2, 10);

  /** Turns pasted/uploaded text (plain "Name: text", "[10:02] Name: text", or WebVTT/SRT) into caption lines. */
  function parseTranscript(raw) {
    const out = [];
    for (let line of String(raw).split(/\r?\n/)) {
      line = line.trim();
      if (!line || /^WEBVTT/i.test(line) || /^\d+$/.test(line) || /-->/.test(line) || /^NOTE\b/.test(line)) continue;
      line = line.replace(/^\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?\)?\s*[-–]?\s*/, "");
      const m = /^([^:]{1,60}):\s+(.+)$/.exec(line) || /^<v\s+([^>]+)>(.+)$/.exec(line);
      if (m) out.push({ speaker: m[1].trim(), text: m[2].replace(/<[^>]+>/g, "").trim() });
      else if (out.length) out[out.length - 1].text += " " + line; // wrapped continuation
      else out.push({ speaker: "", text: line });
    }
    return out.filter((l) => l.text);
  }

  const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  function similarity(a, b) {
    const x = words(a), y = words(b);
    if (!x.size || !y.size) return 0;
    let n = 0; for (const w of x) if (y.has(w)) n++;
    return n / (x.size + y.size - n);
  }

  /** For each live item, the earlier live item it resembles, with whether their deadlines disagree. */
  function findDuplicates(items) {
    const live = items.filter((i) => i.status !== "rejected");
    const out = {};
    for (let i = 0; i < live.length; i++) for (let j = 0; j < i; j++) {
      const a = live[i], b = live[j];
      if (a.kind !== b.kind || a.dismissed || similarity(a.title, b.title) < 0.6) continue;
      out[a.id] = { otherId: b.id, conflict: !!(a.due && b.due && a.due !== b.due) };
      break;
    }
    return out;
  }

  /** Open approved tasks per assignee, across every stored meeting. */
  function workload(stores) {
    const n = {};
    for (const st of stores) for (const i of st.items ?? []) if (i.kind === "task" && i.status === "approved" && !i.done && i.assignee) n[i.assignee] = (n[i.assignee] ?? 0) + 1;
    return n;
  }
  /** Warns when someone is loaded and a teammate on the roster is clearly lighter. */
  function workloadHint(assignee, load, roster, limit = 4) {
    if (!assignee || (load[assignee] ?? 0) < limit) return null;
    const alt = roster.filter((r) => r !== assignee).sort((a, b) => (load[a] ?? 0) - (load[b] ?? 0))[0];
    return alt && (load[alt] ?? 0) < (load[assignee] ?? 0) ? { count: load[assignee], alt, altCount: load[alt] ?? 0 } : null;
  }

  /** Brings a pre-0.4 store ({decisions, tasks}) up to the {items} shape. */
  function migrate(store) {
    if (store?.items) return store;
    return {
      items: [
        ...(store?.decisions ?? []).map((d) => ({ id: d.id ?? uid(), kind: "decision", label: "confirmed", title: d.text, reason: "", evidence: [], assignee: "", due: "", status: "approved", done: false })),
        ...(store?.tasks ?? []).map((t) => ({ id: t.id ?? uid(), kind: "task", label: "confirmed", title: t.title, reason: "", evidence: [], assignee: t.assignee ?? "", due: t.due ?? "", status: "approved", done: !!t.done })),
      ],
    };
  }

  const iso = (d) => d.toISOString().slice(0, 10);
  /** One-tap deadline choices, relative to `now`. */
  function dueChips(now = new Date()) {
    const d = (n) => { const x = new Date(now); x.setUTCDate(x.getUTCDate() + n); return x; };
    const toFri = (((5 - now.getUTCDay()) + 7) % 7) || 7;
    return [["Today", iso(now)], ["Tomorrow", iso(d(1))], ["Friday", iso(d(toFri))], ["Next week", iso(d(7))]];
  }

  const LABELS = { confirmed: "Confirmed commitment", tentative: "Tentative", suggestion: "Suggestion" };
  const badge = (item) => item.kind === "question" ? "Open question" : item.kind === "decision" && item.label === "confirmed" ? "Decision" : LABELS[item.label] ?? "Tentative";

  const api = { uid, parseTranscript, similarity, findDuplicates, workload, workloadHint, migrate, dueChips, badge };
  if (typeof module !== "undefined") module.exports = api; else globalThis.BrainLib = api;
})();
