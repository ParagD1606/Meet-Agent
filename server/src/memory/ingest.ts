import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
import { id as newId } from "../crypto";
import { db } from "../db";
import { memories, memoryEdges, memoryReviews } from "../db/schema";
import { log } from "../log";
import { embed } from "./embed";
import { SHARED_TAG } from "./scope";
import { findContradicted } from "./supersede";

export const CHUNK_CHARS = 3200; // ~800 tokens
export const CHUNK_OVERLAP = 400; // ~100 tokens
const MAX_BYTES = 25 * 1024 * 1024;

type Kind = "pdf" | "html" | "text";

function kindOf(name: string, mime: string): Kind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m = mime.toLowerCase().split(";")[0]!.trim();
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === "text/html" || m === "application/xhtml+xml" || ext === "html" || ext === "htm") return "html";
  if (m.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(m)
    || ["txt", "md", "markdown", "csv", "tsv", "json", "log", "rst"].includes(ext)) return "text";
  throw new Error(`Unsupported document type "${mime || ext}" for ${name} (supported: text, markdown, csv, html, pdf)`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}

export async function extractDocumentText(name: string, mimeType: string, data: Buffer | string): Promise<string> {
  const kind = kindOf(name, mimeType);
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (buf.length > MAX_BYTES) throw new Error(`${name} is too large (${buf.length} bytes, max ${MAX_BYTES})`);
  let text: string;
  if (kind === "pdf") {
    if (typeof data === "string") throw new Error("PDF data must be a Buffer");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    text = (await extractText(pdf, { mergePages: true })).text;
  } else {
    text = buf.toString("utf8");
    if (kind === "html") text = htmlToText(text);
  }
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Splits into ~CHUNK_CHARS windows with overlap, preferring paragraph, then sentence, then word boundaries. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const floor = start + Math.floor(size * 0.6);
      const win = text.slice(floor, end);
      const para = win.lastIndexOf("\n\n");
      const sent = win.lastIndexOf(". ");
      const word = Math.max(win.lastIndexOf("\n"), win.lastIndexOf(" "));
      const pick = para >= 0 ? para : sent >= 0 ? sent + 1 : word;
      if (pick > 0) end = floor + pick;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** Chunks at/above this similarity to a live fact are compared with it by the LLM. */
const CONFLICT_SIM = 0.5;
const MAX_CONFLICT_CHECKS = 10;

/**
 * Light contradiction check for NEW document chunks of shared knowledge: each chunk is compared against its nearest live facts;
 * a conflict is never auto-resolved (documents age and facts can be the wrong side) but queued for an admin as a `doc_conflict`
 * review on the chunk (approve = keep both, reject = hide the chunk). At most 10 LLM calls per document; failures are ignored.
 */
async function flagDocConflicts(tag: string, chunks: { id: number; text: string; embedding: number[] }[]): Promise<number> {
  if (tag !== SHARED_TAG) return 0; // the review queue is admin-visible: never route private content into it
  let flagged = 0;
  for (const c of chunks.slice(0, MAX_CONFLICT_CHECKS)) {
    const lit = `[${c.embedding.join(",")}]`;
    const near = await db.select({ id: memories.id, text: memories.text, sim: sql<number>`1 - (${memories.embedding} <=> ${lit}::vector)` }).from(memories)
      .where(and(eq(memories.scopeTag, tag), eq(memories.kind, "fact"), eq(memories.status, "active"), isNull(memories.invalidAt), eq(memories.reviewState, "ok")))
      .orderBy(sql`${memories.embedding} <=> ${lit}::vector`).limit(3);
    const related = near.filter((n) => Number(n.sim) >= CONFLICT_SIM);
    if (!related.length) continue;
    const hit = await findContradicted(c.text.replace(/^From [^\n]*:\n/, "").slice(0, 1200), related);
    if (!hit.length) continue;
    await db.insert(memoryReviews).values({
      id: newId("rv_"), kind: "doc_conflict", memoryId: c.id,
      payload: { text: c.text.slice(0, 500), conflictsWithFactIds: hit, facts: related.filter((r) => hit.includes(r.id)).map((r) => r.text) },
      requestedBy: "document-ingest",
    });
    flagged++;
  }
  return flagged;
}

/**
 * Extracts, chunks, embeds and stores a document as kind='chunk' rows under `tag`.
 * `tag` is the ACL scope (shared | channel_X | user_X; sync passes user_X for personal sources). With a sourceRef, previous chunks of the same (source, sourceRef) are replaced atomically. Returns #chunks.
 */
export async function ingestDocument(a: {
  tag: string; name: string; mimeType: string; data: Buffer | string; source: string; sourceRef?: string; permalink?: string | null;
}): Promise<number> {
  const text = await extractDocumentText(a.name, a.mimeType, a.data);
  const pieces = text ? chunkText(text).map((c) => `From ${a.name}:\n${c}`) : [];
  // Unchanged chunks of a re-synced document reuse their stored vector (no embed call at all).
  const prior = new Map<string, number[]>();
  if (a.sourceRef && pieces.length) {
    const rows = await db.select({ text: memories.text, embedding: memories.embedding }).from(memories)
      .where(and(eq(memories.scopeTag, a.tag), eq(memories.source, a.source), eq(memories.sourceRef, a.sourceRef), eq(memories.kind, "chunk")));
    for (const r of rows) prior.set(r.text, r.embedding);
  }
  const todo = [...new Set(pieces.filter((p) => !prior.has(p)))];
  const fresh = todo.length ? await embed(todo) : [];
  todo.forEach((p, i) => prior.set(p, fresh[i]!));
  const vectors = pieces.map((p) => prior.get(p)!);
  const changed = new Set(todo);
  const inserted = await db.transaction(async (tx) => {
    if (a.sourceRef) {
      const old = await tx.select({ id: memories.id }).from(memories)
        .where(and(eq(memories.scopeTag, a.tag), eq(memories.source, a.source), eq(memories.sourceRef, a.sourceRef), eq(memories.kind, "chunk")));
      const ids = old.map((o) => o.id);
      if (ids.length) {
        await tx.delete(memoryEdges).where(or(inArray(memoryEdges.fromId, ids), inArray(memoryEdges.toId, ids)));
        await tx.delete(memories).where(inArray(memories.id, ids));
      }
    }
    if (!pieces.length) return [];
    const rows = await tx.insert(memories).values(pieces.map((t, i) => ({
      scopeTag: a.tag, text: t, embedding: vectors[i]!, source: a.source, sourceRef: a.sourceRef ?? null, permalink: a.permalink ?? null, kind: "chunk" as const,
    }))).returning({ id: memories.id });
    return rows.map((r, i) => ({ id: r.id, text: pieces[i]!, embedding: vectors[i]! }));
  });
  // only changed chunks: an unchanged re-sync was already checked
  await flagDocConflicts(a.tag, inserted.filter((c) => changed.has(c.text))).catch((e) => log.warn("document conflict check failed", { err: String(e) }));
  return inserted.length;
}
