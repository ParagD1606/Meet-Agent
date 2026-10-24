import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { isToolError, toolError } from "./errors";
import type { McpToolInfo } from "./client";

/** A callable MCP tool known to this turn but NOT listed in the model's tool schemas. */
export type LazyEntry = {
  /** Unique model-facing key (what the model passes to call_tool). */
  name: string;
  info: McpToolInfo;
  kind: "read" | "write";
  /** Write that posts an approval card (default true when omitted). */
  gated?: boolean;
  /** Runs the call (queue, retry, minify, approval card for writes). */
  run: (args: Record<string, unknown>, fields?: string[]) => Promise<unknown>;
};

const STOP = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "by", "with", "is", "it", "this", "that", "from", "as", "be"]);
const stem = (w: string) =>
  w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
/** Everyday words the model uses that tool names rarely contain: "repos" for repository, "list" for search. */
const QUERY_ALIASES: Record<string, string[]> = { repo: ["repository"], list: ["search"], find: ["search"] };
export const tokenize = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);

// Tokens per MCP tool object. The objects live in client.ts's TTL tool cache, so this index is
// rebuilt exactly when that catalog refreshes and is never rebuilt per turn.
const docCache = new WeakMap<McpToolInfo, string[]>();
function docOf(t: McpToolInfo): string[] {
  let d = docCache.get(t);
  if (!d) {
    const nameToks = tokenize(t.name);
    d = [...nameToks, ...nameToks, ...nameToks, ...tokenize(t.description ?? "")]; // name hits weigh 3x
    docCache.set(t, d);
  }
  return d;
}

/** BM25 over name+description (no embeddings). Returns best matches first; unmatched tools are excluded. */
export function rankTools<T extends { info: McpToolInfo }>(query: string, items: T[], limit = 8): T[] {
  const base = tokenize(query);
  const q = [...new Set([...base, ...base.flatMap((w) => QUERY_ALIASES[w] ?? [])])];
  if (!q.length || !items.length) return [];
  const docs = items.map((i) => docOf(i.info));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  return items
    .map((item, i) => {
      const d = docs[i]!;
      const tf = new Map<string, number>();
      for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
      let s = 0;
      for (const w of q) {
        // exact term, else prefix match (e.g. "issue" vs "issues" is stemmed; "comm" -> "comment")
        const f = tf.get(w) ?? (w.length >= 4 ? [...tf].reduce((n, [t, c]) => n + (t.startsWith(w) ? c * 0.5 : 0), 0) : 0);
        if (!f) continue;
        const n = df.get(w) ?? 1;
        const idf = Math.log(1 + (items.length - n + 0.5) / (n + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { item, s };
    })
    .filter((r) => r.s > 0)
    .sort((a, b2) => b2.s - a.s)
    .slice(0, limit)
    .map((r) => r.item);
}

/** First sentence, capped. Keeps catalogue lines and tool schemas cheap. */
export function shortDesc(d: string | undefined, max = 110): string {
  const one = (d ?? "").replace(/\s+/g, " ").trim();
  const sentence = one.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? one;
  return (sentence.length > max ? sentence.slice(0, max - 1) + "…" : sentence).trim();
}

const DROP_SCHEMA_KEYS = new Set(["$schema", "title", "examples", "$id"]);
/** Smaller schema, same meaning: drops decoration and caps property descriptions. */
export function minSchema(s: unknown, names = false): unknown {
  if (Array.isArray(s)) return s.map((x) => minSchema(x));
  if (!s || typeof s !== "object") return s;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    // `names`: these keys are PROPERTY NAMES (inside "properties"), so a property called "title" or "description" is data, never decoration
    if (!names && (DROP_SCHEMA_KEYS.has(k) || (k === "additionalProperties" && v === false) || (k === "required" && Array.isArray(v) && !v.length))) continue;
    o[k] = !names && k === "description" && typeof v === "string" ? shortDesc(v, 100) : minSchema(v, !names && k === "properties");
  }
  return o;
}

const MAX_SCHEMA_CHARS = 2000;
/** Compact JSON input schema for the model; null when it would be too large to inline. */
export const schemaText = (t: McpToolInfo): string | null => {
  const s = JSON.stringify(minSchema(t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {} }));
  return s.length <= MAX_SCHEMA_CHARS ? s : null;
};

const writeMark = (e: Pick<LazyEntry, "kind" | "gated">) =>
  e.kind !== "write" ? "" : e.gated !== false ? " [WRITE: needs approval]" : " [WRITE: runs immediately]";

/** `name(a*, b, c)` with * on required params; enough for the model to call without the full schema. */
export function signature(t: McpToolInfo, key: string): string {
  const props = Object.keys((t.inputSchema?.properties as Record<string, unknown> | undefined) ?? {});
  const req = new Set((t.inputSchema?.required as string[] | undefined) ?? []);
  return `${key}(${props.slice(0, 12).map((p) => p + (req.has(p) ? "*" : "")).join(", ")}${props.length > 12 ? ", …" : ""})`;
}

const missingRequired = (t: McpToolInfo, args: Record<string, unknown>) =>
  ((t.inputSchema?.required as string[] | undefined) ?? []).filter((k) => args[k] === undefined);

/** Accepts the JSON string the model sends, or an already-parsed object. Null when it is not a JSON object. */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === "") return {};
  let v = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const NAME_LIST_CHARS = 1800;
const MAX_SEARCHES = 3;
const INLINE_SCHEMAS = 3;

/** `search_tools` + `call_tool` over the lazy (unlisted) tools of this turn. Empty set when nothing is lazy. */
export function lazyToolSet(entries: LazyEntry[], apps: string[]): ToolSet {
  if (!entries.length) return {};
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Names alone are cheap (about 5 tokens each) and let the model call the right tool without a search round trip.
  let names = "";
  for (const e of entries) { if (names.length + e.name.length > NAME_LIST_CHARS) { names += ", ..."; break; } names += (names ? ", " : "") + e.name; }
  let searches = 0;
  let lastNames: string[] = [];
  return {
    search_tools: tool({
      description: `Find tools in large connected apps (${apps.join(", ")}) by keyword. Returns the best matches WITH their input schemas (writes included, marked), so you can call_tool right away; do not search again. Tool names: ${names}.`,
      inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(15).optional() }),
      execute: async ({ query, limit }) => {
        if (++searches > MAX_SEARCHES) return `Search limit reached. Pick from: ${lastNames.join(", ") || names}, call it with call_tool now, or tell the user what you could not find.`;
        const hits = rankTools(query, entries, limit ?? 8);
        if (!hits.length) return "No matching tools. Try other keywords (verbs like list, create, search and nouns like issue, page).";
        lastNames = hits.map((h) => h.name);
        return hits.map((h, i) => {
          const head = `${signature(h.info, h.name)}${writeMark(h)} - ${shortDesc(h.info.description)}`;
          const schema = i < INLINE_SCHEMAS ? schemaText(h.info) : null;
          return schema ? `${head}\n  schema: ${schema}` : head;
        }).join("\n");
      },
    }),
    call_tool: tool({
      description: "Run a tool found with search_tools. `args` is a JSON object as a string, e.g. {\"owner\":\"acme\"}. `fields` (optional dot paths) keeps only those fields of a JSON result.",
      // args is a JSON string, not z.record: an open-ended object schema (additionalProperties, no properties) is rejected with HTTP 400 by Gemini.
      inputSchema: z.object({ name: z.string(), args: z.string().optional(), fields: z.array(z.string()).max(20).optional() }),
      execute: async ({ name, args, fields }) => {
        const e = byName.get(name);
        if (!e) return toolError(name, "unknown tool: use search_tools to find the exact name", "not_found");
        const a = parseArgs(args);
        if (!a) return toolError(name, "args must be a JSON object string", "invalid_input");
        const miss = missingRequired(e.info, a);
        const schema = schemaText(e.info);
        if (miss.length) return toolError(name, `missing required: ${miss.join(", ")}. Input schema: ${schema ?? signature(e.info, e.name)}`, "invalid_input");
        const out = await e.run(a, fields);
        // the app rejected the arguments: hand back the schema so the retry is right the first time
        if (isToolError(out) && out.kind === "invalid_input" && schema) return { ...out, message: `${out.message} Input schema: ${schema}`.slice(0, 2600) };
        return out;
      },
    }),
  };
}
