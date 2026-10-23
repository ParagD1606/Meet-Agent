import { and, eq, inArray, or } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
import { db } from "../db";
import { memories, memoryEdges } from "../db/schema";
import { embed } from "./embed";

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

/**
 * Extracts, chunks, embeds and stores a document as kind='chunk' rows under `tag`.
 * With a sourceRef, previous chunks of the same (source, sourceRef) are replaced atomically. Returns #chunks.
 */
export async function ingestDocument(a: {
  tag: string; name: string; mimeType: string; data: Buffer | string; source: string; sourceRef?: string;
}): Promise<number> {
  const text = await extractDocumentText(a.name, a.mimeType, a.data);
  const pieces = text ? chunkText(text).map((c) => `From ${a.name}:\n${c}`) : [];
  const vectors = pieces.length ? await embed(pieces) : [];
  return db.transaction(async (tx) => {
    if (a.sourceRef) {
      const old = await tx.select({ id: memories.id }).from(memories)
        .where(and(eq(memories.source, a.source), eq(memories.sourceRef, a.sourceRef), eq(memories.kind, "chunk")));
      const ids = old.map((o) => o.id);
      if (ids.length) {
        await tx.delete(memoryEdges).where(or(inArray(memoryEdges.fromId, ids), inArray(memoryEdges.toId, ids)));
        await tx.delete(memories).where(inArray(memories.id, ids));
      }
    }
    if (!pieces.length) return 0;
    await tx.insert(memories).values(pieces.map((t, i) => ({
      scopeTag: a.tag, text: t, embedding: vectors[i]!, source: a.source, sourceRef: a.sourceRef ?? null, kind: "chunk" as const,
    })));
    return pieces.length;
  });
}
