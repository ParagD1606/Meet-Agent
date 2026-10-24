/**
 * Guards against invented meeting notes. A task or decision is kept only when the model also returned a quote
 * and that quote really occurs in the source text; an owner is kept only when that person is actually named.
 */
const tokens = (s: string) => s.toLowerCase().replace(/<@[a-z0-9]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

export type Source = { text: string; norm: string; tokens: string[]; index: Map<string, number[]> };

export function makeSource(text: string): Source {
  const toks = tokens(text);
  const index = new Map<string, number[]>();
  toks.forEach((t, i) => { const a = index.get(t); if (a) a.push(i); else index.set(t, [i]); });
  return { text, norm: toks.join(" "), tokens: toks, index };
}

/** True when `quote` (allowing a few dropped or changed words) appears in the source. */
export function quoteSupported(src: Source, quote: string): boolean {
  const q = tokens(quote);
  if (q.length < 2) return false;
  if (src.norm.includes(q.join(" "))) return true;
  // Fuzzy: at least 80% of the quote's words inside one window of the source, anchored on its rarest word.
  const anchor = q.reduce((best, t) => ((src.index.get(t)?.length ?? Infinity) < (src.index.get(best)?.length ?? Infinity) ? t : best), q[0]!);
  const hits = src.index.get(anchor);
  if (!hits) return false;
  const span = Math.ceil(q.length * 1.6) + 2;
  const need = Math.ceil(q.length * 0.8);
  const want = new Set(q);
  for (const pos of hits.slice(0, 400)) {
    const from = Math.max(0, pos - span), to = Math.min(src.tokens.length, pos + span);
    const seen = new Set<string>();
    for (let i = from; i < to; i++) if (want.has(src.tokens[i]!)) seen.add(src.tokens[i]!);
    if (seen.size >= need) return true;
  }
  return false;
}

/** The owner as given when that person appears among the participants or in the text, otherwise null. */
export function verifiedOwner(src: Source, participants: string[], name: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  const known = participants.find((p) => p.toLowerCase() === n.toLowerCase());
  if (known) return known;
  const first = tokens(n);
  if (!first.length) return null;
  const hay = ` ${src.norm} `;
  return hay.includes(` ${first.join(" ")} `) ? n : null;
}
