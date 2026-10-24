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

  const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  /** Renders the small Markdown subset the notes use (## headings, - bullets, **bold**). Escapes first, so model text can't inject HTML. */
  function renderNotes(md) {
    const inline = (t) => escHtml(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const out = []; let open = false;
    for (const raw of String(md).split(/\r?\n/)) {
      const line = raw.trim();
      const li = /^[-*•]\s+(.*)$/.exec(line), h = /^#{1,4}\s+(.*)$/.exec(line);
      if (li) { if (!open) { out.push("<ul>"); open = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
      if (open) { out.push("</ul>"); open = false; }
      if (h) out.push(`<h4>${inline(h[1])}</h4>`); else if (line) out.push(`<p>${inline(line)}</p>`);
    }
    if (open) out.push("</ul>");
    return out.join("");
  }

  /** Longest run where the end of `a` equals the start of `b`, in words (>= 3), as the merged text; else null. */
  function overlapMerge(a, b) {
    const x = a.split(/\s+/), y = b.split(/\s+/);
    for (let n = Math.min(x.length, y.length); n >= 3; n--) {
      if (x.slice(-n).join(" ") === y.slice(0, n).join(" ")) return [...x, ...y.slice(n)].join(" ");
    }
    return null;
  }
  const RECENT_MS = 20_000; // a caption not seen for this long has left the screen; the same words again are new speech
  const wordList = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  /** Share of the shorter text's words found in the longer one: high when a recognizer revises words mid-sentence. */
  function containment(a, b) {
    const x = new Set(wordList(a)), y = new Set(wordList(b));
    if (x.size < 4 || y.size < 4) return 0;
    let n = 0; for (const w of x) if (y.has(w)) n++;
    return n / Math.min(x.size, y.size);
  }
  /**
   * Whether `text` is the same utterance as `prev`, and what the merged text should be. Handles growth, repeats,
   * Meet trimming the start of a long caption, and speech recognition rewriting earlier words as it hears more.
   */
  const startsWithWords = (long, short) => short.length > 0 && short.length <= long.length && short.every((w, i) => long[i] === w);
  function continuation(prev, text) {
    if (text === prev || text.startsWith(prev)) return text;
    if (prev.startsWith(text)) return prev;
    // Same words, different punctuation or capitalisation ("so." then "so we will...").
    const pw = wordList(prev), tw = wordList(text);
    if (startsWithWords(tw, pw)) return text;
    if (startsWithWords(pw, tw)) return prev;
    const joined = overlapMerge(prev, text);
    if (joined) return joined;
    if (containment(prev, text) >= 0.7) return text.length >= prev.length * 0.8 ? text : prev;
    return null;
  }

  /**
   * Folds the captions currently on screen into the running transcript. A caption block that keeps its DOM node
   * (`key`) is the same line however its words change; without a key, or when the node is reused for new speech,
   * a snapshot line only becomes a new transcript line when it is not a continuation of the speaker's recent lines.
   */
  function mergeCaptions(lines, snapshot, now = Date.now()) {
    for (const { speaker, text, key } of snapshot) {
      if (!text) continue;
      let line = null, merged = null;
      if (key !== undefined) {
        const k = lines.find((l) => l.key === key && l.speaker === speaker);
        if (k) {
          merged = continuation(k.text, text);
          if (merged !== null || k.text.length < 20) { line = k; merged ??= text; }
          else delete k.key; // the node now carries new speech
        }
      }
      if (!line) {
        for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 6; i--) {
          const l = lines[i];
          if (l.speaker !== speaker) continue;
          seen++;
          if (now - (l.u ?? l.t) > RECENT_MS) continue;
          const m = continuation(l.text, text);
          if (m !== null) { line = l; merged = m; break; }
        }
      }
      if (line) { line.text = merged; line.u = now; if (key !== undefined) line.key = key; }
      else lines.push({ speaker, text, t: now, u: now, ...(key !== undefined ? { key } : {}) });
    }
    return lines;
  }

  const api = { mergeCaptions, renderNotes, uid, parseTranscript, similarity, findDuplicates, workload, workloadHint, migrate, dueChips, badge };
  if (typeof module !== "undefined") module.exports = api; else globalThis.BrainLib = api;
})();
