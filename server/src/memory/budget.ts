/** Token accounting helpers shared by recall, context assembly, compaction and the bench. No I/O. */

/** ~4 chars/token for latin text; CJK and symbol-heavy text tokenise denser, so count those chars at 1 token. */
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x2e7f) wide++;
  return Math.ceil((s.length - wide) / 4) + wide;
}

export type Depth = "direct" | "memory" | "tools" | "deep";

/** What each depth is allowed to spend (CONTRACTS "Token efficiency" 2, 8). */
export function depthPlan(depth: Depth): { recall: boolean; tools: boolean; maxOutputTokens: number } {
  switch (depth) {
    case "direct": return { recall: false, tools: false, maxOutputTokens: 400 };
    case "memory": return { recall: true, tools: false, maxOutputTokens: 800 };
    case "tools": return { recall: true, tools: true, maxOutputTokens: 2000 };
    case "deep": return { recall: true, tools: true, maxOutputTokens: 2000 };
  }
}

const TRIVIAL = /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|got it|sounds good|lgtm|perfect|awesome|good morning|good night|gm|gn|yes|no|yep|nope|sure|np|:[a-z0-9_+-]+:|[\p{Extended_Pictographic}\s])+[.!?\s]*$/iu;

/** Greetings, acks, thanks, emoji: never worth recall, tools or fact extraction. */
export function isTrivialMessage(text: string): boolean {
  const t = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!t) return true;
  if (t.length > 40) return false;
  return TRIVIAL.test(t);
}

/**
 * Greedy pack of `items` (already in priority order) under `budget` tokens. Items that do not fit are skipped
 * (a later, shorter one may still fit). The sum of returned items' tokens never exceeds `budget`.
 */
export function packToBudget<T>(items: T[], budget: number, render: (item: T) => string): { packed: T[]; lines: string[]; tokens: number } {
  const packed: T[] = [];
  const lines: string[] = [];
  let tokens = 0;
  for (const item of items) {
    const line = render(item);
    const t = estimateTokens(line) + 1; // +1 for the joining newline
    if (tokens + t > budget) continue;
    packed.push(item);
    lines.push(line);
    tokens += t;
  }
  return { packed, lines, tokens };
}

export type Breakdown = {
  system: number; coreBlocks: number; skills: number; toolSchemas: number;
  history: number; recall: number; toolResults: number; user: number; total: number;
};

/** Approximate first-step prompt composition (stored in turns.promptBreakdown). Pass raw strings; missing parts count 0. */
export function breakdown(parts: Partial<Record<Exclude<keyof Breakdown, "total">, string | number | null | undefined>>): Breakdown {
  const n = (v: string | number | null | undefined) => (typeof v === "number" ? Math.round(v) : estimateTokens(v));
  const b = {
    system: n(parts.system), coreBlocks: n(parts.coreBlocks), skills: n(parts.skills), toolSchemas: n(parts.toolSchemas),
    history: n(parts.history), recall: n(parts.recall), toolResults: n(parts.toolResults), user: n(parts.user),
  };
  return { ...b, total: Object.values(b).reduce((a, c) => a + c, 0) };
}

/** Best-effort secret redaction for anything that may be persisted into a summary. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/gi, "$1: [REDACTED]");
}
