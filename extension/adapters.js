// One adapter per platform. `read()` returns the captions currently on screen as [{ speaker, text }].
// These selectors target each product's caption UI, which the vendors change without notice;
// when a platform stops capturing, this file is the only place to update.
(() => {
  const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  // A caption block that keeps its DOM node is the same line however the recognizer rewrites its words.
  const keys = new WeakMap(); let nextKey = 1;
  const blockKey = (el) => { if (!keys.has(el)) keys.set(el, nextKey++); return keys.get(el); };

  const adapters = {
    meet: {
      match: (h) => h === "meet.google.com",
      title() {
        const t = document.title.replace(/^Meet\s*[-–]\s*/, "").replace(/\s*[-–]\s*Google Meet$/, "").trim();
        const day = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
        // A bare meeting code says little; a named meeting keeps its name.
        return !t || /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(t) ? `Google Meet · ${t || this.meetingId()} · ${day}` : t;
      },
      meetingId: () => location.pathname.split("/").filter(Boolean)[0] || location.pathname,
      // Names only: Meet does not put attendee emails in the page. Your own entry reads "Name (You)".
      participantNames() {
        const list = document.querySelector('[role="list"][aria-label*="articipant" i]');
        return [...(list?.querySelectorAll('[role="listitem"]') ?? [])].map((li) => (li.getAttribute("aria-label") || text(li.querySelector("span"))).trim()).filter(Boolean);
      },
      roster() { return this.participantNames().map((n) => n.replace(/\s*\(.*?\)\s*$/, "").trim()).filter((n) => n && !/^you$/i.test(n)); },
      // Captions label your own speech "You"; this is the name behind it, when the participant list is open.
      selfName() {
        const me = this.participantNames().find((n) => /\(you\)\s*$/i.test(n));
        return me ? me.replace(/\s*\(.*?\)\s*$/, "").trim() || null : null;
      },
      // The CC button says "Turn on captions" or "Turn off captions"; that is more reliable than whether a caption is on screen right now.
      captionsButton: () => [...document.querySelectorAll('button[aria-label*="captions" i]')].find((b) => /turn (on|off) captions/i.test(b.getAttribute("aria-label") || "")) ?? null,
      captionsOn() {
        const label = this.captionsButton()?.getAttribute("aria-label") || "";
        if (/turn off/i.test(label)) return true;
        if (/turn on/i.test(label)) return false;
        return !!(document.querySelector('[role="region"][aria-label*="aption" i]') || document.querySelector('div[jsname="dsyhDe"]'));
      },
      enableCaptions() {
        const b = this.captionsButton();
        if (!b || !/turn on/i.test(b.getAttribute("aria-label") || "")) return false;
        b.click(); return true;
      },
      read() {
        // Caption region is labelled for screen readers; each block is [avatar][speaker name][text].
        const region = document.querySelector('[role="region"][aria-label*="aption" i]') || document.querySelector('div[jsname="dsyhDe"]');
        if (!region) return [];
        const out = [];
        for (const block of region.querySelectorAll(":scope > div > div, :scope > div")) {
          const kids = [...block.children].filter((k) => text(k));
          // A caption is a name and its words, both plain text; a container of several captions is not one.
          if (kids.length < 2 || kids.slice(-2).some((k) => k.querySelector("div"))) continue;
          const speaker = text(kids[kids.length - 2]);
          const words = text(kids[kids.length - 1]);
          if (words && speaker && speaker !== words) out.push({ speaker, text: words, key: blockKey(block) });
        }
        return out;
      },
    },
    teams: {
      match: (h) => h.endsWith("teams.microsoft.com") || h.endsWith("teams.live.com"),
      title: () => document.title.replace(/\s*\|\s*Microsoft Teams.*$/, "").trim() || "Microsoft Teams meeting",
      meetingId: () => location.hash.match(/threadId[=/]([^&/]+)/)?.[1] || location.pathname,
      read() {
        const out = [];
        for (const item of document.querySelectorAll('[data-tid="closed-caption-v2-virtual-list-content"] .ui-chat__item, [data-tid="closed-caption-renderer-wrapper"] .ui-chat__item')) {
          const speaker = text(item.querySelector('[data-tid="author"]'));
          const words = text(item.querySelector('[data-tid="closed-caption-text"]'));
          if (words) out.push({ speaker, text: words });
        }
        return out;
      },
    },
    zoom: {
      match: (h) => h.endsWith("zoom.us"),
      title: () => document.title.replace(/\s*[-–|]\s*Zoom.*$/i, "").trim() || "Zoom meeting",
      meetingId: () => location.pathname.match(/\/(?:wc\/)?(\d{9,})/)?.[1] || location.pathname,
      read() {
        const out = [];
        for (const row of document.querySelectorAll('#live-transcription-subtitle, .live-transcription-subtitle__box, [class*="subtitle"][class*="item"]')) {
          const speaker = text(row.querySelector('[class*="name"], [class*="speaker"]'));
          const words = text(row.querySelector('[class*="text"], [class*="content"]')) || (speaker ? "" : text(row));
          if (words && words !== speaker) out.push({ speaker, text: words });
        }
        return out;
      },
    },
  };

  // Slack's caption markup is unverified: this looks for any caption-like element and, inside it,
  // a speaker/text pair, so expect to adjust it after inspecting a real Huddle.
  adapters.slack = {
    match: (h) => h === "app.slack.com",
    title: () => "Slack Huddle",
    meetingId: () => location.pathname.split("/").filter(Boolean).slice(-2).join("-") || "huddle",
    read() {
      if (!/\/huddle\b|\/client\//.test(location.pathname)) return [];
      const out = [];
      // Only inside a Huddle: "caption" also appears on image captions in ordinary messages.
      const boxes = document.querySelectorAll('[class*="huddle" i] [data-qa*="caption" i], [data-qa*="huddle" i] [data-qa*="caption" i], [class*="huddle" i] [class*="caption" i], [data-qa*="huddle" i] [class*="caption" i]');
      for (const box of boxes) {
        const speaker = text(box.querySelector('[data-qa*="name" i], [class*="name" i], [class*="speaker" i]'));
        const words = text(box.querySelector('[data-qa*="text" i], [class*="text" i], [class*="content" i]')) || (!speaker ? text(box) : "");
        if (words && words !== speaker) out.push({ speaker, text: words });
      }
      return out;
    },
  };

  const key = Object.keys(adapters).find((k) => adapters[k].match(location.hostname));
  globalThis.__brainAdapter = key ? { platform: key, ...adapters[key] } : null;
})();
